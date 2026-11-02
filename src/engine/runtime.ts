import { randomUUID } from 'node:crypto';
import type { CommandDef } from '../dsl/commands.js';
import type { Executable } from '../dsl/executables.js';
import type { FlowDef, FlowNode, HaltOptions } from '../dsl/flows.js';
import type { HarnessDef } from '../dsl/harness.js';
import type { LaneAny, LaneDef } from '../dsl/lanes.js';
import type { JournalDef, MemoryDraft } from '../dsl/memory.js';
import type { ModelPolicyDef } from '../dsl/policies.js';
import type { UnitView } from '../dsl/views.js';
import { validate, type Problem } from '../dsl/validate.js';
import type { Client, ControlApi, KindRef, Ledger, LedgerEvent, MemoryItem, Metrics, Model, ModelDriver, ModelResponse, Resolver, SequencedEvent, State, UnitRecord, Window } from '../kernel/index.js';
import type { Account, AccountState, QuotaEvent, QuotaPartition } from '../kernel/quota.js';
import type { Json, JsonObject, PortRef } from '../kernel/refs.js';
import { flowVersion, nodeAt } from './address.js';
import { ControlError, controlApiFor } from './control.js';
import { computeDemand } from './demand.js';
import { stepName } from './events.js';
import { GuardServer, type GuardContext } from './guards.js';
import { buildMemo } from './memo.js';
import { LedgerMetrics } from './metrics.js';
import { foldAccountState } from './quota.js';
import { recall, type RecallScope, type Recalled } from './recall.js';
import { accountsOf, modelsOf, partitionsOf, seatSteps, seatsOf, type AnySeat } from './seats.js';
import { startSuppliers } from './supply.js';
import { TriggerEngine } from './triggers.js';
import { walk, type WalkOutcome } from './walker.js';

export interface RuntimeOptions {
  readonly harness: HarnessDef;
  readonly drivers: readonly ModelDriver[];
  readonly resolver: Resolver;
  readonly metrics?: Metrics;
  readonly now?: () => Date;
  readonly holder?: string;
  readonly claimTtlMs?: number;
  /** The hook server guarded seat steps need; without it a guarded step refuses to start. */
  readonly hooks?: { readonly port: number | PortRef };
  readonly tickMs?: number;
  readonly log?: (message: string) => void;
}

export class StartupError extends Error {
  public constructor(public readonly problems: readonly Problem[]) {
    super(`harness cannot start:\n${problems.map((problem) => `  [${problem.rule}] ${problem.message}`).join('\n')}`);
    this.name = 'StartupError';
  }
}

type AnyLane = LaneDef<unknown, State, unknown, string>;
type Body<E> = E extends unknown ? Omit<E, 'account' | 'harness'> : never;
export type QuotaEventBody = Body<QuotaEvent>;

export interface AcquiredAccount {
  readonly account?: Account;
  readonly resumeAt?: Date;
  readonly detail: string;
}

export interface ExecutableResult {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly output?: Json;
}

interface AttributeSchema {
  safeParse(value: unknown): { readonly success: boolean; readonly data?: unknown; readonly error?: { readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[] } };
  partial?(): AttributeSchema;
}

export const DEFAULT_TICK_MS = 5_000;
export const DEFAULT_CLAIM_TTL_MS = 30_000;

export class Runtime {
  public readonly harness: HarnessDef;
  public readonly ledger: Ledger;
  public readonly resolver: Resolver;
  public readonly metrics: Metrics;
  public readonly holder: string;
  public readonly now: () => Date;
  private readonly drivers: ReadonlyMap<string, ModelDriver>;
  private readonly claimTtlMs: number;
  private readonly tickMs: number;
  private readonly log: (message: string) => void;
  private readonly ledgerMetrics: LedgerMetrics | undefined;
  private readonly triggerEngine: TriggerEngine;
  private readonly seatOrder: readonly AnySeat[];
  private readonly seatModels = new Map<string, string>();
  private readonly shareOverrides = new Map<string, number>();
  private readonly partitions: readonly QuotaPartition[];
  private readonly paused = new Set<string>();
  private readonly listeners = new Set<(event: SequencedEvent) => void>();
  private readonly leasesHeld = new Map<string, Set<string>>();
  private readonly clocks = new Map<string, Set<string>>();
  private readonly hooksPort: number | PortRef | undefined;
  private guards: GuardServer | undefined;
  private readonly clientStops: (() => Promise<void>)[] = [];
  private seq = 0;
  private started = false;
  private running = false;
  private wake: (() => void) | undefined;
  private stopSuppliers: (() => Promise<void>) | undefined;

  public constructor(options: RuntimeOptions) {
    const problems = [...validate(options.harness)];
    const drivers = new Map(options.drivers.map((driver) => [driver.driver, driver]));
    for (const step of seatSteps(options.harness)) {
      for (const model of modelsOf(step.seat)) {
        const driver = drivers.get(model.driver);
        if (!driver) problems.push({ rule: 11, message: `seat "${step.seat.name}" chooses model "${model.name}" of driver "${model.driver}", which is not registered` });
        else if (step.guarded && !driver.hooks) problems.push({ rule: 13, message: `step "${step.path}" guards seat "${step.seat.name}" but driver "${driver.name}" has no hooks` });
      }
      if (step.guarded && !options.hooks) problems.push({ rule: 13, message: `step "${step.path}" guards seat "${step.seat.name}" but the runtime has no hook server; pass \`hooks: { port }\`` });
    }
    if (problems.length > 0) throw new StartupError(problems);
    this.harness = options.harness;
    this.seatOrder = seatsOf(options.harness);
    this.partitions = partitionsOf(options.harness);
    this.ledger = options.harness.ledgerDef!;
    this.resolver = options.resolver;
    this.now = options.now ?? (() => new Date());
    this.ledgerMetrics = options.metrics ? undefined : new LedgerMetrics(this.ledger, this.harness, this.now);
    this.metrics = options.metrics ?? this.ledgerMetrics!;
    this.holder = options.holder ?? `${options.harness.name}:${randomUUID()}`;
    this.claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    this.log = options.log ?? ((message) => console.error(message));
    this.hooksPort = options.hooks?.port;
    this.drivers = drivers;
    this.triggerEngine = new TriggerEngine(this, this.ledgerMetrics ?? new LedgerMetrics(this.ledger, this.harness, this.now));
  }

  public async start(): Promise<void> {
    const claim = await this.ledger.claimWriter(this.holder, this.claimTtlMs);
    if (!claim.acquired) throw new Error(`ledger is held by "${claim.holder}" until ${claim.expiresAt.toISOString()}`);
    try {
      await this.joinPartitions();
    } catch (err) {
      await this.ledger.releaseWriter(this.holder);
      throw err;
    }
    this.started = true;
    for await (const { seq, event } of this.ledger.read({})) {
      this.seq = seq;
      this.note(event);
    }
    await this.triggerEngine.prime();
    if (this.hooksPort !== undefined) {
      this.guards = new GuardServer(
        { takeLease: (attemptId, resource) => this.takeLease(attemptId, resource), runCheck: (exec) => this.runCheck(exec) },
        typeof this.hooksPort === 'number' ? this.hooksPort : this.resolver.port(this.hooksPort),
      );
      await this.guards.start();
    }
    this.stopSuppliers = await startSuppliers(this);
    for (const client of this.harness.clientList) {
      const handle = await client.serve(this.controlApiFor(client), this.resolver);
      this.clientStops.push(handle.stop);
    }
    for (const record of await this.ledger.units({ attemptStatus: ['running', 'blocked'] })) {
      const attempt = record.unit.attempt;
      if (!attempt) continue;
      if (attempt.status === 'running') {
        await this.resumeAttempt(record.unit.id);
        continue;
      }
      if (attempt.blockedOn === 'decision') {
        const lane = this.lane(record.unit.lane);
        const memo = await buildMemo(this.ledger, lane.handlerDef!.flow, record, attempt.id);
        const decision = memo.decisions.get(attempt.step);
        if (decision !== undefined) await this.resumeAttempt(record.unit.id, { step: attempt.step, decision });
      }
    }
  }

  /** Starts, then ticks until `stop()`: the daemon's main loop. */
  public async run(): Promise<void> {
    await this.start();
    this.running = true;
    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        this.log(`tick failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      }
      if (!this.running) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.tickMs);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = undefined;
    }
  }

  public async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    for (const stop of this.clientStops.splice(0).reverse()) await stop();
    if (this.guards) await this.guards.stop();
    this.guards = undefined;
    if (this.stopSuppliers) await this.stopSuppliers();
    this.stopSuppliers = undefined;
    await this.ledger.releaseWriter(this.holder);
    this.started = false;
  }

  public async append(events: readonly LedgerEvent[]): Promise<readonly number[]> {
    if (!this.started) await this.ledger.claimWriter(this.holder, this.claimTtlMs);
    const seqs = await this.ledger.append(events, this.holder);
    for (const event of events) this.note(event);
    this.seq = Math.max(this.seq, ...seqs);
    const sequenced = events.map((event, index) => ({ seq: seqs[index]!, event }));
    for (const entry of sequenced) for (const listener of this.listeners) listener(entry);
    if (this.harness.observerList.length > 0) {
      if (this.ledgerMetrics) await this.ledgerMetrics.refresh();
      const query = { unit: (id: string) => this.ledger.unit(id), metrics: this.metrics, resolver: this.resolver };
      for (const entry of sequenced) {
        for (const observer of this.harness.observerList) {
          await observer.observe(entry, query).catch((err: unknown) => this.log(`observer "${observer.name}" failed on ${entry.event.type}: ${err instanceof Error ? err.message : String(err)}`));
        }
      }
    }
    return seqs;
  }

  public subscribe(listener: (event: SequencedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private note(event: LedgerEvent): void {
    if (event.type === 'lanePaused') this.paused.add(event.lane);
    if (event.type === 'laneResumed') this.paused.delete(event.lane);
    if (event.type === 'invocation' && event.ok && event.seat && event.model) this.seatModels.set(event.seat, event.model);
    if (event.type === 'accountShared') this.shareOverrides.set(event.account, event.fraction);
  }

  private async joinPartitions(): Promise<void> {
    for (const partition of this.partitions) {
      const joined = await partition.join(this.harness.name, this.holder, this.claimTtlMs);
      if (!joined.accepted) throw new Error(`partition "${partition.name}" refuses harness "${this.harness.name}": held by "${joined.heldBy}"`);
    }
  }

  public lastSeq(): number {
    return this.seq;
  }

  public pausedLanes(): ReadonlySet<string> {
    return this.paused;
  }

  public async find(unitId: string): Promise<UnitRecord | undefined> {
    return this.ledger.unit(unitId);
  }

  public async record(unitId: string): Promise<UnitRecord> {
    const record = await this.ledger.unit(unitId);
    if (!record) throw new ControlError(`unit "${unitId}" does not exist`, 404);
    return record;
  }

  public lane(name: string): AnyLane {
    const lane = this.harness.laneList.find((candidate) => candidate.name === name);
    if (!lane) throw new Error(`lane "${name}" is not registered`);
    return lane as AnyLane;
  }

  public laneNamed(name: string): AnyLane {
    const lane = this.harness.laneList.find((candidate) => candidate.name === name);
    if (!lane) throw new ControlError(`lane "${name}" is not registered`, 400);
    return lane as AnyLane;
  }

  public journalNamed(name: string): JournalDef {
    const journal = this.harness.journalList.find((candidate) => candidate.name === name);
    if (!journal) throw new ControlError(`journal "${name}" is not registered`, 400);
    if (!journal.memoryStore) throw new ControlError(`journal "${name}" has no store`, 400);
    return journal;
  }

  /** Attributes a client hands in, checked against the lane's kind; `partial` for a patch. */
  public attributesFor(laneName: string, attributes: unknown, partial = false): JsonObject {
    const lane = this.laneNamed(laneName);
    const kind = lane.kind as { readonly attributeSchema?: AttributeSchema };
    const schema = partial && kind.attributeSchema?.partial ? kind.attributeSchema.partial() : kind.attributeSchema;
    if (!schema) return attributes as JsonObject;
    const parsed = schema.safeParse(attributes);
    if (!parsed.success) throw new ControlError(`attributes do not fit kind "${lane.kind.name}": ${(parsed.error?.issues ?? []).map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`).join('; ')}`, 400);
    return parsed.data as JsonObject;
  }

  public async recordMemory(journal: JournalDef, draft: MemoryDraft, by: string): Promise<string> {
    if (!journal.memoryStore) throw new Error(`journal "${journal.name}" has no store to record into`);
    const id = `mem-${randomUUID()}`;
    await journal.memoryStore.put({
      id,
      memoryKind: journal.memoryKind.name,
      journal: journal.name,
      createdAt: this.now(),
      status: draft.status ?? 'candidate',
      when: {
        kinds: (draft.when?.kinds ?? []).map((kind) => kind.name),
        roles: (draft.when?.roles ?? []).map((role) => role.name),
        resources: (draft.when?.resources ?? []).map((resource) => resource.name),
        facets: (draft.when?.facets ?? []).map((facet) => ({ facet: facet.facet.name, value: facet.value })),
      },
      text: `${draft.text}`,
      trackRecord: { used: 0, succeeded: 0 },
    });
    void by;
    return id;
  }

  /** Runs a command through its fixed runner: for triggers, custom operations, escalations and stop checks. */
  public async runExecutable(exec: Executable<unknown, unknown>, input: unknown): Promise<ExecutableResult> {
    if (exec.entity !== 'command') throw new Error(`the engine can run a command here, not a ${exec.entity}`);
    const command = exec as CommandDef<unknown, unknown>;
    const runner = command.runnerChoice;
    if (!runner || runner.entity !== 'runner') throw new Error(`command "${command.name}" has no fixed runner for the engine to use`);
    const result = await runner.backend.exec({ argv: command.argvOf ? command.argvOf(input) : [], env: {} }, new AbortController().signal, this.resolver);
    const ok = command.acceptedExitCodes.includes(result.exitCode);
    if (ok && command.outputSchema) return { ok, exitCode: result.exitCode, output: command.outputSchema.parse(JSON.parse(result.stdout)) as Json };
    return { ok, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }

  private async runCheck(exec: Executable<void, unknown>): Promise<{ readonly ok: boolean; readonly detail: string }> {
    try {
      const result = await this.runExecutable(exec as Executable<unknown, unknown>, undefined);
      return { ok: result.ok, detail: result.stderr?.trim() || result.stdout?.trim() || `exit ${result.exitCode}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  public unitView(record: UnitRecord): UnitView<unknown> {
    const lane = this.lane(record.unit.lane);
    const state = (lane.kind as { readonly stateList?: readonly State[] }).stateList?.find((candidate) => candidate.name === record.unit.state) ?? {
      entity: 'state' as const,
      name: record.unit.state,
      position: record.unit.statePosition,
    };
    const { statePosition: _position, attempt, ...unit } = record.unit;
    return {
      ...unit,
      kind: { entity: 'kind', name: record.unit.kind },
      lane: { entity: 'lane', name: record.unit.lane },
      state,
      ...(attempt
        ? {
            attempt: {
              id: attempt.id,
              number: attempt.number,
              status: attempt.status,
              step: attempt.step,
              ...(attempt.blockedOn ? { blockedOn: attempt.blockedOn } : {}),
              ...(attempt.halt ? { halt: { entity: 'halt' as const, name: attempt.halt } } : {}),
              startedAt: attempt.startedAt,
            },
          }
        : {}),
    };
  }

  public driverFor(model: Model): ModelDriver {
    const driver = this.drivers.get(model.driver);
    if (!driver) throw new Error(`no driver registered for "${model.driver}", which model "${model.name}" needs`);
    return driver;
  }

  private currentModel(seat: AnySeat): Model | undefined {
    const name = this.seatModels.get(seat.name);
    return name === undefined ? undefined : modelsOf(seat).find((model) => model.name === name);
  }

  /**
   * The seat's model: fixed, or chosen by its policy with the seat's current model and its peers'.
   * Seats sharing a `distinct` policy are ordered by registration; a later seat may not take a model
   * an earlier seat holds, so a swap is the earlier seat moving and the later one yielding (design §3.8).
   */
  public async chooseModel(seat: AnySeat, kind: KindRef, attemptId: string): Promise<Model> {
    const choice = seat.modelChoice!;
    if (choice.entity === 'model') return choice;
    const policy = choice as ModelPolicyDef;
    const sharers = this.seatOrder.filter((candidate) => candidate.modelChoice === policy);
    const peers = sharers
      .filter((candidate) => candidate !== seat)
      .flatMap((candidate) => {
        const model = this.currentModel(candidate);
        return model ? [{ seat: candidate, model }] : [];
      });
    const current = this.currentModel(seat);
    const picked = policy.decide({ kind, seat, ...(current ? { current } : {}), peers, metrics: this.metrics });
    const at = this.now();
    await this.append([{ type: 'policyDecision', attemptId, policy: policy.name, value: picked.name, at }]);
    if (!policy.distinct) return picked;
    const earlier = sharers.slice(0, sharers.indexOf(seat));
    const holderOf = (model: Model) => earlier.find((candidate) => this.currentModel(candidate)?.name === model.name);
    const holder = holderOf(picked);
    if (!holder) return picked;
    const kept = current && !holderOf(current) ? current : policy.candidates.find((candidate) => !holderOf(candidate));
    if (!kept) throw new Error(`policy "${policy.name}" has no model left for seat "${seat.name}"`);
    await this.append([{ type: 'policyRefused', attemptId, policy: policy.name, reason: `seat "${seat.name}" chose "${picked.name}", which seat "${holder.name}" holds`, kept: kept.name, at }]);
    return kept;
  }

  public accountNamed(seat: AnySeat, name: string): Account | undefined {
    return accountsOf(seat).find((account) => account.name === name);
  }

  private accounts(): readonly Account[] {
    const byName = new Map<string, Account>();
    for (const seat of this.seatOrder) for (const account of accountsOf(seat)) byName.set(account.name, account);
    for (const share of this.harness.shares) byName.set(share.account.name, share.account);
    return [...byName.values()];
  }

  public shareFor(account: Account): number {
    return this.shareOverrides.get(account.name) ?? this.harness.shares.find((share) => share.account.name === account.name)?.fraction ?? 1;
  }

  public async shareAccount(name: string, fraction: number, by: string): Promise<void> {
    if (!this.accounts().some((account) => account.name === name)) throw new ControlError(`account "${name}" is not registered`, 400);
    await this.append([{ type: 'accountShared', account: name, fraction, by, at: this.now() }]);
  }

  public async accountStates(): Promise<readonly (AccountState & { readonly name: string; readonly driver: string; readonly partition: string })[]> {
    const now = this.now();
    const states = [];
    for (const account of this.accounts()) {
      const state = await foldAccountState(account, this.harness.name, this.shareFor(account), now);
      states.push({ ...state, name: account.name, driver: account.driver, partition: account.quota.name });
    }
    return states;
  }

  /**
   * An account of the seat's pool for one call (design §5.10): candidates fold from the partition,
   * the drain policy chooses among them, a cooled-down or over-share pick is refused and recorded,
   * the fallback serves when the pool has nothing, and nothing at all blocks the step on budget
   * until the soonest cooldown or window reset.
   */
  public async acquireAccount(seat: AnySeat, model: Model, excluded: ReadonlySet<string>, attemptId: string): Promise<AcquiredAccount> {
    const pool = seat.poolDef!;
    const driver = this.driverFor(model);
    const now = this.now();
    const serves = (account: Account) => account.driver === model.driver && driver.serves(account) && !excluded.has(account.name);
    const fold = (account: Account) => foldAccountState(account, this.harness.name, this.shareFor(account), now);
    const eligible = (state: AccountState) => (state.cooldownUntil === undefined || state.cooldownUntil <= now) && state.shareUsed < state.shareCap;
    const candidates: AccountState[] = [];
    for (const account of pool.accountList) if (serves(account)) candidates.push(await fold(account));
    const fallback = pool.fallbackAccount && serves(pool.fallbackAccount) ? await fold(pool.fallbackAccount) : undefined;
    const fallbackReady = fallback && eligible(fallback) ? fallback : undefined;
    let chosen: AccountState | undefined;
    if (pool.drainPolicy) {
      const policy = pool.drainPolicy;
      const picked = candidates.length > 0 ? policy.decide({ candidates, now }) : undefined;
      if (candidates.length > 0) await this.append([{ type: 'policyDecision', attemptId, policy: policy.name, value: picked?.account.name ?? null, at: now }]);
      if (picked && eligible(picked)) chosen = picked;
      else if (picked) {
        const why = picked.cooldownUntil && picked.cooldownUntil > now ? `cooling down until ${picked.cooldownUntil.toISOString()}` : `over its share (${picked.shareUsed.toFixed(2)} of ${picked.shareCap})`;
        await this.append([{ type: 'policyRefused', attemptId, policy: policy.name, reason: `account "${picked.account.name}" is ${why}`, kept: fallbackReady?.account.name ?? null, at: now }]);
      }
    } else {
      chosen = candidates.find(eligible);
    }
    chosen ??= fallbackReady;
    if (chosen) return { account: chosen.account, detail: '' };
    const states = fallback ? [...candidates, fallback] : candidates;
    const resumeAt = states
      .flatMap((state) => [state.cooldownUntil, state.windowResetsAt])
      .filter((when): when is Date => when instanceof Date && when > now)
      .sort((p, q) => p.getTime() - q.getTime())[0];
    const described = states.map((state) => `${state.account.name} (utilization ${state.utilization.toFixed(2)}, share ${state.shareUsed.toFixed(2)} of ${state.shareCap}${state.cooldownUntil && state.cooldownUntil > now ? `, cooling down until ${state.cooldownUntil.toISOString()}` : ''})`);
    return { detail: `pool "${pool.name}" has no account to serve seat "${seat.name}": ${described.join('; ') || 'none it can serve'}`, ...(resumeAt ? { resumeAt } : {}) };
  }

  public async quotaEvents(account: Account, events: readonly QuotaEventBody[]): Promise<void> {
    if (events.length === 0) return;
    await account.quota.append(events.map((event) => ({ ...event, account: account.name, harness: this.harness.name }) as QuotaEvent));
  }

  public async recallFor(scope: RecallScope): Promise<Recalled> {
    return recall(this.harness.journalList, scope);
  }

  /** Items a role recorded during a call enter the journals that list it as a recorder, as candidates (design §5.11). */
  public async recordFromRole(role: string, seat: string, recorded: NonNullable<ModelResponse['recorded']>): Promise<void> {
    for (const entry of recorded) {
      const journal = this.harness.journalList.find((candidate) => candidate.name === entry.journal);
      if (!journal?.memoryStore || !journal.recorders.some((recorder) => recorder.name === role)) continue;
      await journal.memoryStore.put({
        id: `mem-${randomUUID()}`,
        memoryKind: journal.memoryKind.name,
        journal: journal.name,
        createdAt: this.now(),
        status: 'candidate',
        when: entry.when,
        text: entry.text,
        trackRecord: { used: 0, succeeded: 0 },
      });
      void seat;
    }
  }

  private async settleTrackRecords(attemptId: string, succeeded: boolean): Promise<void> {
    const ids: string[] = [];
    for await (const { event } of this.ledger.read({ attemptId, types: ['invocation'] })) {
      if (event.type !== 'invocation' || !event.ok) continue;
      for (const id of event.memory ?? []) if (!ids.includes(id)) ids.push(id);
    }
    if (ids.length === 0) return;
    const items = new Map<string, { readonly journal: JournalDef; readonly item: MemoryItem }>();
    for (const journal of this.harness.journalList) {
      if (!journal.memoryStore) continue;
      for (const item of await journal.memoryStore.list({ journal: journal.name })) items.set(item.id, { journal, item });
    }
    for (const id of ids) {
      const found = items.get(id);
      if (!found) continue;
      const record = found.item.trackRecord;
      await found.journal.memoryStore!.update(id, { trackRecord: { used: record.used + 1, succeeded: record.succeeded + (succeeded ? 1 : 0) } });
    }
  }

  public hookEndpoint(): string {
    if (!this.guards) throw new Error('the runtime has no hook server; pass `hooks: { port }`');
    return this.guards.endpoint();
  }

  public registerGuard(invocation: string, context: GuardContext): { readonly endpoint: string; readonly invocation: string; readonly leases: boolean; readonly stop: boolean } {
    if (!this.guards) throw new Error('the runtime has no hook server; pass `hooks: { port }`');
    this.guards.register(invocation, context);
    return { endpoint: this.guards.endpoint(), invocation, leases: context.leases, stop: context.beforeStop !== undefined };
  }

  public unregisterGuard(invocation: string): void {
    this.guards?.unregister(invocation);
  }

  private async takeLease(attemptId: string, resource: string): Promise<boolean> {
    const held = this.leasesHeld.get(attemptId) ?? new Set<string>();
    if (held.has(resource)) return true;
    if (!(await this.ledger.takeLease(attemptId, resource, 'exclusive'))) return false;
    held.add(resource);
    this.leasesHeld.set(attemptId, held);
    await this.append([{ type: 'leaseTaken', attemptId, resource, mode: 'exclusive', waitedMs: 0, at: this.now() }]);
    return true;
  }

  /** The events that close an attempt's leases and clocks; they go in front of its `attemptEnded`. */
  private closingEvents(attemptId: string): LedgerEvent[] {
    const at = this.now();
    const events: LedgerEvent[] = [...(this.leasesHeld.get(attemptId) ?? [])].map((resource) => ({ type: 'leaseReleased', attemptId, resource, at }));
    this.leasesHeld.delete(attemptId);
    return [...events, ...this.disarmEvents(attemptId)];
  }

  private disarmEvents(attemptId: string): LedgerEvent[] {
    const at = this.now();
    const events: LedgerEvent[] = [...(this.clocks.get(attemptId) ?? [])].map((timerId) => ({ type: 'timerCleared', timerId, reason: 'disarmed', at }));
    this.clocks.delete(attemptId);
    return events;
  }

  private clockEvents(attemptId: string, unitId: string, step: string, clocks: { readonly escalateMinutes?: number; readonly timeoutMinutes?: number }): LedgerEvent[] {
    const at = this.now();
    const armed = new Set<string>();
    const events: LedgerEvent[] = [];
    for (const [owner, minutes] of [
      ['escalate', clocks.escalateMinutes],
      ['timeout', clocks.timeoutMinutes],
    ] as const) {
      if (minutes === undefined) continue;
      const timerId = `${attemptId}:${step}:${owner}`;
      armed.add(timerId);
      events.push({ type: 'timerSet', timerId, unitId, owner: `${owner}:${step}`, fireAt: new Date(at.getTime() + minutes * 60_000), reason: 'armed', at });
    }
    if (armed.size > 0) this.clocks.set(attemptId, armed);
    return events;
  }

  public async createUnit(lane: LaneAny, attrs: unknown, options: { readonly parentId?: string; readonly source: string; readonly key?: string }): Promise<string | undefined> {
    const def = this.lane(lane.name);
    const kind = def.kind as { readonly keyOf?: (attrs: unknown) => string; readonly initialState?: State };
    const key = options.key ?? (kind.keyOf ? kind.keyOf(attrs) : randomUUID());
    const open = (await this.ledger.units({ lane: lane.name, key })).find((record) => record.unit.position !== 'terminal');
    const at = this.now();
    if (open) {
      await this.append([{ type: 'createSkipped', lane: lane.name, key, openUnitId: open.unit.id, source: options.source, at }]);
      return undefined;
    }
    const unitId = `unit-${randomUUID()}`;
    const initial = kind.initialState!;
    await this.append([
      { type: 'unitCreated', unitId, lane: lane.name, kind: def.kind.name, key, ...(options.parentId ? { parentId: options.parentId } : {}), attributes: attrs as JsonObject, source: options.source, at },
      { type: 'transition', unitId, to: initial.name, position: initial.position, cause: `created:${options.source}`, at },
    ]);
    return unitId;
  }

  public async childrenOf(parentId: string, lane: LaneAny): Promise<readonly UnitRecord[]> {
    return (await this.ledger.units({ lane: lane.name })).filter((record) => record.unit.parentId === parentId);
  }

  /** An update through the control API applies at once (design §5.5). */
  public async updateAttributes(unitId: string, patch: unknown, by: string): Promise<void> {
    const record = await this.record(unitId);
    const checked = this.attributesFor(record.unit.lane, patch, true);
    await this.append([{ type: 'attributesUpdated', unitId, attributes: { ...record.unit.attributes, ...checked }, by, applied: true, at: this.now() }]);
  }

  public async cancelUnit(unitId: string, reason: string, by: string): Promise<void> {
    const record = await this.record(unitId);
    await this.deliverSignal(record.unit.lane, record.unit.key, 'cancel', { reason }, by);
  }

  public async pauseLane(name: string, reason: string, by: string): Promise<void> {
    this.laneNamed(name);
    await this.append([{ type: 'lanePaused', lane: name, reason, by, at: this.now() }]);
  }

  public async resumeLane(name: string, reason: string, by: string): Promise<void> {
    this.laneNamed(name);
    await this.append([{ type: 'laneResumed', lane: name, reason, by, at: this.now() }]);
  }

  public controlApiFor(client: Client): ControlApi {
    return controlApiFor(this, client);
  }

  /** The summary a supervisor reads: per lane, per seat and per halt, over an optional window. */
  public async telemetry(window?: Window): Promise<{ readonly lanes: readonly object[]; readonly seats: readonly object[]; readonly halts: readonly object[] }> {
    if (this.ledgerMetrics) await this.ledgerMetrics.refresh();
    const scope = window ? { window } : {};
    const lanes = this.harness.laneList.map((lane) => {
      const { count: _count, ...outcomes } = this.metrics.outcomes({ of: lane, ...scope });
      return {
        lane: lane.name,
        outcomes,
        attempts: this.metrics.attempts({ of: lane, ...scope }),
        paused: this.metrics.paused({ lane: { entity: 'lane', name: lane.name }, ...scope }),
      };
    });
    const seats = this.seatOrder.map((seat) => {
      const totals = { succeeded: 0, failed: 0, cancelled: 0, retried: 0, samples: 0 };
      for (const lane of this.harness.laneList) {
        const counts = this.metrics.attempts({ of: lane, seat, ...scope });
        totals.succeeded += counts.succeeded;
        totals.failed += counts.failed;
        totals.cancelled += counts.cancelled;
        totals.retried += counts.retried;
        totals.samples += counts.samples;
      }
      const model = this.seatModels.get(seat.name);
      return { seat: seat.name, ...(model ? { model } : {}), attempts: { ...totals, successRate: totals.samples === 0 ? 0 : totals.succeeded / totals.samples } };
    });
    const halts = new Map<string, { readonly entity: 'halt'; readonly name: string }>();
    const visit = (nodes: readonly FlowNode[]): void => {
      for (const node of nodes) {
        if (node.type === 'halt') halts.set(node.halt.name, { entity: 'halt', name: node.halt.name });
        if (node.type === 'step') for (const raised of node.options.halts ?? []) halts.set(raised.name, { entity: 'halt', name: raised.name });
        if (node.type === 'when' || node.type === 'loop') visit(node.nodes);
      }
    };
    for (const lane of this.harness.laneList as readonly AnyLane[]) if (lane.handlerDef) visit(lane.handlerDef.flow.nodes);
    return { lanes, seats, halts: [...halts.values()].map((halt) => ({ halt: halt.name, decisions: this.metrics.decisions({ halt, ...scope }) })) };
  }

  public async startAttempt(unitId: string, serviceClass: 'expedite' | 'fixedDate' | 'standard' = 'standard'): Promise<WalkOutcome> {
    const record = await this.record(unitId);
    if (record.unit.attempt) throw new Error(`unit "${unitId}" already has an open attempt`);
    const lane = this.lane(record.unit.lane);
    const flow = lane.handlerDef!.flow;
    const attemptId = `attempt-${randomUUID()}`;
    const at = this.now();
    await this.append([
      { type: 'demandGranted', lane: lane.name, unitId, serviceClass, at },
      { type: 'attemptStarted', unitId, attemptId, number: record.unit.attempts + 1, fromStep: flow.nodes[0]?.name ?? '', flow: flow.name, flowVersion: flowVersion(flow), serviceClass, at },
    ]);
    return this.drive(unitId);
  }

  public async resumeAttempt(unitId: string, resume?: { readonly step: string; readonly decision?: Json }): Promise<WalkOutcome> {
    const record = await this.record(unitId);
    const attempt = record.unit.attempt;
    if (!attempt) throw new Error(`unit "${unitId}" has no open attempt`);
    if (attempt.status === 'blocked') {
      await this.append([{ type: 'attemptResumed', attemptId: attempt.id, step: attempt.step, at: this.now() }]);
    }
    return this.drive(unitId, resume);
  }

  private async drive(unitId: string, resume?: { readonly step: string; readonly decision?: Json }): Promise<WalkOutcome> {
    const record = await this.record(unitId);
    const attempt = record.unit.attempt!;
    const lane = this.lane(record.unit.lane);
    const flow = lane.handlerDef!.flow;
    if (record.cursor && record.cursor.flowVersion !== flowVersion(flow)) {
      const outcome: WalkOutcome = { kind: 'blocked', step: attempt.step, on: 'interrupted', detail: 'definitionChanged' };
      await this.append([{ type: 'attemptBlocked', attemptId: attempt.id, step: attempt.step, on: 'definitionChanged', detail: `flow "${flow.name}" changed from ${record.cursor.flowVersion} to ${flowVersion(flow)}`, at: this.now() }]);
      return outcome;
    }
    const memo = await buildMemo(this.ledger, flow, record, attempt.id);
    const outcome = await walk({ runtime: this, lane, flow, record, attemptId: attempt.id, memo, metrics: this.metrics, ...(resume ? { resume } : {}) });
    await this.settle(record, lane, outcome);
    return outcome;
  }

  private async settle(record: UnitRecord, lane: AnyLane, outcome: WalkOutcome): Promise<void> {
    const attemptId = record.unit.attempt!.id;
    const unitId = record.unit.id;
    const at = this.now();
    if (outcome.kind === 'blocked') {
      const on = outcome.on === 'interrupted' && outcome.detail === 'definitionChanged' ? 'definitionChanged' : outcome.on;
      await this.append([
        { type: 'attemptBlocked', attemptId, step: outcome.step, on, ...(outcome.halt ? { halt: outcome.halt.name } : {}), ...(outcome.ask ? { ask: outcome.ask } : {}), ...(outcome.detail ? { detail: outcome.detail } : {}), ...(outcome.facets ? { facets: outcome.facets } : {}), at },
        ...(outcome.resumeAt
          ? [{ type: 'timerSet' as const, timerId: `${attemptId}:${outcome.step}`, unitId, owner: `resume:${outcome.step}`, fireAt: outcome.resumeAt, reason: 'armed' as const, at }]
          : []),
        ...(outcome.on === 'decision' && outcome.clocks ? this.clockEvents(attemptId, unitId, outcome.step, outcome.clocks) : []),
      ]);
      return;
    }
    if (outcome.kind === 'exit') {
      const state = lane.handlerDef!.exits[outcome.exit];
      if (!state) throw new Error(`lane "${lane.name}" maps no state for exit "${outcome.exit}"`);
      await this.append([
        ...this.closingEvents(attemptId),
        { type: 'attemptEnded', attemptId, outcome: 'succeeded', exit: outcome.exit, costUsd: 0, at },
        { type: 'transition', unitId, from: record.unit.state, to: state.name, position: state.position, ...(state.verdict ? { verdict: state.verdict } : {}), attemptId, cause: `exit:${outcome.exit}`, at },
        ...(await this.deferredPatches(unitId, record.unit.attempt!.startedAt)),
      ]);
      await this.settleTrackRecords(attemptId, true);
      return;
    }
    const failed = record.unit.failedAttempts + 1;
    const retry = lane.retryPolicy;
    const tries = retry?.tries ?? 0;
    if (failed <= tries) {
      const delay = (retry?.initialDelayMs ?? 60_000) * (retry?.backoff === 'exponential' ? 2 ** (failed - 1) : 1);
      await this.append([
        ...this.closingEvents(attemptId),
        { type: 'attemptEnded', attemptId, outcome: 'failed', detail: outcome.error, costUsd: 0, at },
        { type: 'retryScheduled', unitId, failedAttempts: failed, notBefore: new Date(at.getTime() + delay), at },
        ...(await this.deferredPatches(unitId, record.unit.attempt!.startedAt)),
      ]);
      await this.settleTrackRecords(attemptId, false);
      return;
    }
    const exhausted = retry?.exhausted as State | { readonly state: State; readonly reopenAfter: { readonly minutes?: number; readonly hours?: number; readonly days?: number } } | undefined;
    if (!exhausted) {
      await this.append([{ type: 'attemptBlocked', attemptId, step: outcome.step, on: 'stepFailure', detail: outcome.error, at }]);
      return;
    }
    const target = 'state' in exhausted ? exhausted.state : exhausted;
    const events: LedgerEvent[] = [
      ...this.closingEvents(attemptId),
      { type: 'attemptEnded', attemptId, outcome: 'failed', detail: outcome.error, costUsd: 0, at },
      { type: 'retryScheduled', unitId, failedAttempts: failed, notBefore: at, at },
      { type: 'transition', unitId, from: record.unit.state, to: target.name, position: target.position, ...(target.verdict ? { verdict: target.verdict } : {}), attemptId, cause: 'retry:exhausted', at },
    ];
    if ('state' in exhausted) {
      const after = exhausted.reopenAfter;
      const ms = (after.minutes ?? 0) * 60_000 + (after.hours ?? 0) * 3_600_000 + (after.days ?? 0) * 86_400_000;
      events.push({ type: 'timerSet', timerId: `${unitId}:reopen`, unitId, owner: 'reopen', fireAt: new Date(at.getTime() + ms), reason: 'armed', at });
    }
    await this.append([...events, ...(await this.deferredPatches(unitId, record.unit.attempt!.startedAt))]);
    await this.settleTrackRecords(attemptId, false);
  }

  private async deferredPatches(unitId: string, since: Date): Promise<LedgerEvent[]> {
    let merged: JsonObject = {};
    let any = false;
    for await (const { event } of this.ledger.read({ unitId, types: ['attributesUpdated'], since })) {
      if (event.type === 'attributesUpdated' && !event.applied) {
        merged = { ...merged, ...event.attributes };
        any = true;
      }
    }
    return any ? [{ type: 'attributesUpdated', unitId, attributes: merged, by: 'engine:merge', applied: true, at: this.now() }] : [];
  }

  private async blockedFacets(attemptId: string, step: string): Promise<readonly { readonly facet: string; readonly value: string }[]> {
    let facets: readonly { readonly facet: string; readonly value: string }[] = [];
    for await (const { event } of this.ledger.read({ attemptId, types: ['attemptBlocked'] })) {
      if (event.type === 'attemptBlocked' && event.step === step && event.facets) facets = event.facets;
    }
    return facets;
  }

  public async resolveHalt(unitId: string, decision: Json, by: string, resolvedBy: 'human' | 'timeout' = 'human'): Promise<WalkOutcome> {
    const record = await this.record(unitId);
    const attempt = record.unit.attempt;
    if (!attempt || attempt.status !== 'blocked' || attempt.blockedOn !== 'decision' || !attempt.halt) throw new ControlError(`unit "${unitId}" is not waiting on a decision`, 400);
    const facets = await this.blockedFacets(attempt.id, attempt.step);
    await this.append([
      ...this.disarmEvents(attempt.id),
      { type: 'decisionRecorded', attemptId: attempt.id, step: attempt.step, halt: attempt.halt, decision, resolvedBy, by, facets, at: this.now() },
    ]);
    return this.resumeAttempt(unitId, { step: attempt.step, decision });
  }

  public async deliverSignal(laneName: string, key: string, signalName: string, payload: Json, source: string): Promise<void> {
    const lane = this.laneNamed(laneName);
    const open = (await this.ledger.units({ lane: laneName, key })).find((record) => record.unit.position !== 'terminal');
    const at = this.now();
    if (!open) {
      await this.append([{ type: 'signalSkipped', lane: laneName, key, signal: signalName, source, at }]);
      return;
    }
    const reaction = lane.reactions.find((entry) => entry.signal.name === signalName)?.reaction;
    if (!reaction) throw new ControlError(`lane "${laneName}" has no reaction to "${signalName}"`, 400);
    const unitId = open.unit.id;
    const attempt = open.unit.attempt;
    const gated = reaction.at !== undefined && attempt !== undefined && !reaction.at.includes(attempt.step.split('/')[0]!.replace(/\[\d+\]$/, ''));
    const applied: ('update' | 'rewind' | 'enter')[] = [];
    const events: LedgerEvent[] = [];
    if (reaction.update) {
      const next = reaction.update(open.unit.attributes, payload) as JsonObject;
      const deferred = attempt !== undefined && attempt.status === 'running' && gated;
      events.push({ type: 'attributesUpdated', unitId, attributes: next, by: source, applied: !deferred, at });
      applied.push('update');
    }
    if (!gated && reaction.rewind && attempt) {
      events.push({ type: 'attemptRewound', attemptId: attempt.id, from: attempt.step, to: reaction.rewind, signal: signalName, at });
      applied.push('rewind');
    }
    if (!gated && reaction.enter) {
      if (attempt) events.push(...this.closingEvents(attempt.id), { type: 'attemptEnded', attemptId: attempt.id, outcome: 'cancelled', costUsd: 0, at });
      events.push({ type: 'transition', unitId, from: open.unit.state, to: reaction.enter.name, position: reaction.enter.position, ...(reaction.enter.verdict ? { verdict: reaction.enter.verdict } : {}), ...(attempt ? { attemptId: attempt.id } : {}), cause: `signal:${signalName}`, at });
      applied.push('enter');
    }
    events.push({ type: 'signalDelivered', unitId, signal: signalName, payload, source, applied, ...(gated && attempt ? { gatedAtStep: attempt.step } : {}), at });
    await this.append(events);
    if (applied.includes('rewind') && attempt?.status === 'blocked') {
      await this.resumeAttempt(unitId);
    }
  }

  public async recover(unitId: string, action: 'restartFromTop' | 'abandon' | 'continue', by: string): Promise<WalkOutcome | undefined> {
    const record = await this.record(unitId);
    const attempt = record.unit.attempt;
    if (!attempt || attempt.status !== 'blocked') throw new ControlError(`unit "${unitId}" has no blocked attempt to recover`, 400);
    const at = this.now();
    await this.append([{ type: 'attemptRecovered', attemptId: attempt.id, action, by, at }]);
    if (action === 'continue') return this.resumeAttempt(unitId, { step: attempt.step });
    await this.append([...this.closingEvents(attempt.id), { type: 'attemptEnded', attemptId: attempt.id, outcome: 'cancelled', costUsd: 0, at }]);
    if (action === 'restartFromTop') return this.startAttempt(unitId);
    const lane = this.lane(record.unit.lane);
    const cancel = lane.reactions.find((entry) => entry.signal.name === 'cancel')?.reaction;
    if (cancel?.enter) {
      await this.append([{ type: 'transition', unitId, from: record.unit.state, to: cancel.enter.name, position: cancel.enter.position, ...(cancel.enter.verdict ? { verdict: cancel.enter.verdict } : {}), cause: `recover:${action}`, at }]);
    }
    return undefined;
  }

  private haltOptionsAt(record: UnitRecord): HaltOptions<unknown, unknown, Record<string, unknown>, unknown> | undefined {
    const attempt = record.unit.attempt;
    if (!attempt) return undefined;
    const node = nodeAt(this.lane(record.unit.lane).handlerDef!.flow, attempt.step);
    return node?.type === 'halt' ? node.options : undefined;
  }

  private async flowCtx(record: UnitRecord): Promise<{ unit: UnitView<unknown>; params: unknown; steps: Record<string, unknown>; now: Date; iteration: number }> {
    const lane = this.lane(record.unit.lane);
    const memo = await buildMemo(this.ledger, lane.handlerDef!.flow, record, record.unit.attempt!.id);
    const steps = Object.fromEntries([...memo.outputs.entries()].map(([addr, output]) => [stepName(addr), output]));
    return { unit: this.unitView(record), params: lane.handlerDef?.params, steps, now: this.now(), iteration: 0 };
  }

  /** A halt clock fired: escalation runs its executable; timeout resolves the halt with the declared decision (design §5.7). */
  private async fireClock(timer: { readonly timerId: string; readonly unitId: string; readonly owner: string }): Promise<void> {
    const separator = timer.owner.indexOf(':');
    const kind = timer.owner.slice(0, separator);
    const step = timer.owner.slice(separator + 1);
    const record = await this.record(timer.unitId);
    const attempt = record.unit.attempt;
    if (!attempt || attempt.status !== 'blocked' || attempt.blockedOn !== 'decision' || attempt.step !== step || !attempt.halt) return;
    this.clocks.get(attempt.id)?.delete(timer.timerId);
    const options = this.haltOptionsAt(record);
    if (kind === 'escalate' && options?.escalate) {
      await this.append([{ type: 'haltEscalated', attemptId: attempt.id, step, halt: attempt.halt, at: this.now() }]);
      await this.runExecutable(options.escalate.run as Executable<unknown, unknown>, undefined);
    }
    if (kind === 'timeout' && options?.timeout) {
      const decision = options.timeout.decide(await this.flowCtx(record)) as Json;
      await this.resolveHalt(timer.unitId, decision, 'timeout', 'timeout');
    }
  }

  public async tick(): Promise<void> {
    const now = this.now();
    await this.joinPartitions();
    if (this.ledgerMetrics) await this.ledgerMetrics.refresh();
    for (const timer of await this.ledger.dueTimers(now)) {
      await this.append([{ type: 'timerFired', timerId: timer.timerId, unitId: timer.unitId, at: now }]);
      if (timer.owner.startsWith('resume:')) {
        const record = await this.record(timer.unitId);
        if (record.unit.attempt?.status === 'blocked') await this.resumeAttempt(timer.unitId, { step: timer.owner.slice('resume:'.length) });
      } else if (timer.owner === 'reopen') {
        const record = await this.record(timer.unitId);
        const initial = (this.lane(record.unit.lane).kind as { readonly initialState?: State }).initialState!;
        await this.append([{ type: 'transition', unitId: timer.unitId, from: record.unit.state, to: initial.name, position: initial.position, cause: 'reopen', at: now }]);
      } else if (timer.owner.startsWith('escalate:') || timer.owner.startsWith('timeout:')) {
        await this.fireClock(timer);
      }
    }
    for (const record of await this.ledger.units({ attemptStatus: ['blocked'] })) {
      if (record.unit.attempt?.blockedOn === 'children') {
        const lane = this.lane(record.unit.lane);
        const node = lane.handlerDef!.flow.nodes.find((candidate) => candidate.type === 'spawn');
        if (!node || node.type !== 'spawn') continue;
        const children = await this.childrenOf(record.unit.id, node.lane);
        if (children.length > 0 && children.every((child) => child.unit.position === 'terminal')) await this.resumeAttempt(record.unit.id, { step: record.unit.attempt.step });
      }
    }
    await this.triggerEngine.process();
    for (const grant of await computeDemand(this)) {
      await this.startAttempt(grant.unitId, grant.serviceClass);
    }
    await this.triggerEngine.process();
  }
}
