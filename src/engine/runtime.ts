import { randomUUID } from 'node:crypto';
import type { CommandDef } from '../dsl/commands.js';
import type { Executable } from '../dsl/executables.js';
import type { FlowNode, HaltOptions } from '../dsl/flows.js';
import type { HarnessDef } from '../dsl/harness.js';
import type { LaneAny, LaneDef } from '../dsl/lanes.js';
import type { JournalDef, MemoryDraft } from '../dsl/memory.js';
import type { ModelPolicyDef } from '../dsl/policies.js';
import type { UnitView } from '../dsl/views.js';
import { validate, type Problem } from '../dsl/validate.js';
import type { Client, ControlApi, KindRef, LeaseMode, Ledger, LedgerEvent, MemoryItem, Metrics, Model, ModelDriver, ModelResponse, Resolver, SequencedEvent, State, UnitRecord, Window } from '../kernel/index.js';
import type { Account, AccountState, QuotaEvent, QuotaPartition } from '../kernel/quota.js';
import type { Json, JsonObject, PortRef } from '../kernel/refs.js';
import { flowVersion, nodeAt } from './address.js';
import { ControlError, controlApiFor } from './control.js';
import { computeDemand } from './demand.js';
import { stepName, unitViewOf } from './events.js';
import { GuardServer, type GuardContext } from './guards.js';
import { buildMemo, supersededBy } from './memo.js';
import { LedgerMetrics, recordingMetrics } from './metrics.js';
import { foldAccountState } from './quota.js';
import { recall, type RecallScope, type Recalled } from './recall.js';
import { accountsOf, modelsOf, partitionsOf, seatSteps, seatsOf, type AnySeat } from './seats.js';
import { startSuppliers } from './supply.js';
import { TriggerEngine } from './triggers.js';
import { walk, workspaceOf, type WalkOutcome } from './walker.js';

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

interface Resume {
  readonly step: string;
  readonly decision?: Json;
}

interface ValueSchema {
  safeParse(value: unknown): { readonly success: boolean; readonly data?: unknown; readonly error?: { readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[] } };
  partial?(): ValueSchema;
}

interface DueTimer {
  readonly timerId: string;
  readonly unitId: string;
  readonly owner: string;
}

export const DEFAULT_TICK_MS = 5_000;
export const DEFAULT_CLAIM_TTL_MS = 30_000;
/** The delay before a failed attempt's first retry when the lane's policy names none. */
export const DEFAULT_RETRY_DELAY_MS = 60_000;
/** The `by` of the attributes patch that merges deferred updates at an attempt's end. */
const MERGE_BY = 'engine:merge';

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function issuesOf(parsed: ReturnType<ValueSchema['safeParse']>): string {
  return (parsed.error?.issues ?? []).map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`).join('; ');
}

/** The keys of `next` whose value differs from `base`: a deferred update as a delta, so two deferred updates compose. */
function differing(base: JsonObject, next: JsonObject): JsonObject {
  const delta: Record<string, Json> = {};
  for (const [key, value] of Object.entries(next)) if (JSON.stringify(base[key]) !== JSON.stringify(value)) delta[key] = value;
  return delta;
}

function topStep(step: string): string {
  return stepName(step.split('/')[0]!);
}

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
  /** Per attempt, the mode its lease on each resource holds; folded from `leaseTaken` and `leaseReleased`. */
  private readonly leasesHeld = new Map<string, Map<string, LeaseMode>>();
  /** Per unit, the halt clocks armed for its open attempt. */
  private readonly clocks = new Map<string, Set<string>>();
  /** Per unit, the `resume:` timer armed for its blocked attempt. */
  private readonly resumeTimers = new Map<string, string>();
  private readonly timerUnits = new Map<string, string>();
  private readonly unitLanes = new Map<string, string>();
  private readonly unitKeys = new Map<string, string>();
  /** Per unit, the predecessor key its last `orderHeld` names. */
  private readonly orderHolds = new Map<string, string>();
  private readonly leaseWaits = new Map<string, Date>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly aborts = new Map<string, AbortController>();
  private readonly drives = new Map<string, Promise<WalkOutcome>>();
  private readonly hooksPort: number | PortRef | undefined;
  private guards: GuardServer | undefined;
  private readonly clientStops: (() => Promise<void>)[] = [];
  private held: ReadonlySet<string> = new Set();
  private renewal: NodeJS.Timeout | undefined;
  private started = false;
  private stopped = false;
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

  /**
   * Claims the ledger, folds its history, replays it to the observers, resumes the attempts the last
   * run left open, and only then serves suppliers and clients, so nothing acts on a stale picture.
   */
  public async start(): Promise<void> {
    if (this.stopped) throw new Error(`runtime "${this.holder}" is stopped and cannot start again`);
    const claim = await this.ledger.claimWriter(this.holder, this.claimTtlMs);
    if (!claim.acquired) throw new Error(`ledger is held by "${claim.holder}" until ${claim.expiresAt.toISOString()}`);
    try {
      await this.joinPartitions();
      this.renewal = setInterval(() => void this.renew(), Math.max(1, Math.floor(this.claimTtlMs / 3)));
      this.renewal.unref();
      this.started = true;
      const history: SequencedEvent[] = [];
      for await (const row of this.ledger.read({})) {
        this.note(row.event);
        if (this.harness.observerList.length > 0) history.push(row);
      }
      await this.observe(history);
      await this.triggerEngine.prime();
      if (this.hooksPort !== undefined) {
        this.guards = new GuardServer(
          { takeLease: (attemptId, resource) => this.takeLease(attemptId, resource), runCheck: (exec, cwd) => this.runCheck(exec, cwd) },
          typeof this.hooksPort === 'number' ? this.hooksPort : this.resolver.port(this.hooksPort),
        );
        await this.guards.start();
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
      this.stopSuppliers = await startSuppliers(this);
      for (const client of this.harness.clientList) {
        const handle = await client.serve(this.controlApiFor(client), this.resolver);
        this.clientStops.push(handle.stop);
      }
    } catch (err) {
      if (this.renewal) clearInterval(this.renewal);
      this.renewal = undefined;
      this.started = false;
      await this.ledger.releaseWriter(this.holder);
      throw err;
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

  /** Cancels the walks in flight (their attempts stay open for the next start), serves nobody, lets the ledger go. */
  public async stop(): Promise<void> {
    if (this.stopped) return;
    this.running = false;
    this.wake?.();
    if (this.renewal) clearInterval(this.renewal);
    this.renewal = undefined;
    for (const controller of this.aborts.values()) controller.abort();
    await Promise.allSettled([...this.drives.values()]);
    for (const stop of this.clientStops.splice(0).reverse()) await stop();
    if (this.guards) await this.guards.stop();
    this.guards = undefined;
    if (this.stopSuppliers) await this.stopSuppliers();
    this.stopSuppliers = undefined;
    this.stopped = true;
    this.started = false;
    await this.ledger.releaseWriter(this.holder);
  }

  private async renew(): Promise<void> {
    try {
      const claim = await this.ledger.claimWriter(this.holder, this.claimTtlMs);
      if (!claim.acquired) this.log(`ledger claim lost to "${claim.holder}"`);
      await this.joinPartitions();
    } catch (err) {
      this.log(`renewal failed: ${message(err)}`);
    }
  }

  public async append(events: readonly LedgerEvent[]): Promise<readonly number[]> {
    if (this.stopped) throw new Error(`runtime "${this.holder}" is stopped and writes nothing`);
    if (!this.started) await this.ledger.claimWriter(this.holder, this.claimTtlMs);
    const seqs = await this.ledger.append(events, this.holder);
    for (const event of events) this.note(event);
    const sequenced = events.map((event, index) => ({ seq: seqs[index]!, event }));
    for (const entry of sequenced) for (const listener of this.listeners) listener(entry);
    await this.observe(sequenced);
    await this.mirror(events);
    return seqs;
  }

  private async observe(entries: readonly SequencedEvent[]): Promise<void> {
    if (entries.length === 0 || this.harness.observerList.length === 0) return;
    if (this.ledgerMetrics) await this.ledgerMetrics.refresh();
    const query = { unit: (id: string) => this.ledger.unit(id), metrics: this.metrics, resolver: this.resolver };
    for (const entry of entries) {
      for (const observer of this.harness.observerList) {
        await observer.observe(entry, query).catch((err: unknown) => this.log(`observer "${observer.name}" failed on ${entry.event.type}: ${message(err)}`));
      }
    }
  }

  /** A lane's store follows the ledger: every transition and applied patch of its units reaches the store (design §3.12). */
  private async mirror(events: readonly LedgerEvent[]): Promise<void> {
    for (const event of events) {
      if (event.type !== 'transition' && !(event.type === 'attributesUpdated' && event.applied)) continue;
      const laneName = this.unitLanes.get(event.unitId);
      const key = this.unitKeys.get(event.unitId);
      const lane = laneName === undefined ? undefined : (this.harness.laneList.find((candidate) => candidate.name === laneName) as AnyLane | undefined);
      const store = lane?.storeDef;
      if (!lane || !store || key === undefined) continue;
      try {
        if (event.type === 'transition') {
          if (event.cause.startsWith('created:')) continue;
          const mapped = (lane.storeMap?.states as Readonly<Record<string, string>> | undefined)?.[event.to] ?? event.to;
          await store.transition(key, mapped, this.resolver);
        } else {
          await store.save(key, event.attributes, this.resolver);
        }
      } catch (err) {
        this.log(`store "${store.name}" failed on ${event.type} of unit "${event.unitId}": ${message(err)}`);
      }
    }
  }

  public subscribe(listener: (event: SequencedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private note(event: LedgerEvent): void {
    switch (event.type) {
      case 'lanePaused':
        this.paused.add(event.lane);
        return;
      case 'laneResumed':
        this.paused.delete(event.lane);
        return;
      case 'invocation':
        if (event.ok && event.seat && event.model) this.seatModels.set(event.seat, event.model);
        return;
      case 'accountShared':
        this.shareOverrides.set(event.account, event.fraction);
        return;
      case 'unitCreated':
        this.unitLanes.set(event.unitId, event.lane);
        this.unitKeys.set(event.unitId, event.key);
        return;
      case 'timerSet': {
        this.timerUnits.set(event.timerId, event.unitId);
        if (event.owner.startsWith('resume:')) this.resumeTimers.set(event.unitId, event.timerId);
        if (event.owner.startsWith('escalate:') || event.owner.startsWith('timeout:')) {
          const armed = this.clocks.get(event.unitId) ?? new Set<string>();
          armed.add(event.timerId);
          this.clocks.set(event.unitId, armed);
        }
        return;
      }
      case 'timerCleared':
      case 'timerFired': {
        const unitId = event.type === 'timerFired' ? event.unitId : this.timerUnits.get(event.timerId);
        if (unitId === undefined) return;
        if (this.resumeTimers.get(unitId) === event.timerId) this.resumeTimers.delete(unitId);
        this.clocks.get(unitId)?.delete(event.timerId);
        return;
      }
      case 'leaseTaken': {
        const held = this.leasesHeld.get(event.attemptId) ?? new Map<string, LeaseMode>();
        held.set(event.resource, event.mode);
        this.leasesHeld.set(event.attemptId, held);
        return;
      }
      case 'leaseReleased':
        this.leasesHeld.get(event.attemptId)?.delete(event.resource);
        return;
      case 'attemptEnded':
        this.leasesHeld.delete(event.attemptId);
        return;
      case 'orderHeld':
        this.orderHolds.set(event.unitId, event.predecessorKey);
        return;
      case 'attemptStarted':
      case 'transition':
        this.orderHolds.delete(event.unitId);
        return;
      default:
        return;
    }
  }

  private async joinPartitions(): Promise<void> {
    for (const partition of this.partitions) {
      const joined = await partition.join(this.harness.name, this.holder, this.claimTtlMs);
      if (!joined.accepted) throw new Error(`partition "${partition.name}" refuses harness "${this.harness.name}": held by "${joined.heldBy}"`);
    }
  }

  /** Work on one unit happens in turn: a cancel, a decision and a settling walk never interleave their reads and writes. */
  private async withUnit<T>(unitId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(unitId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const turn = previous.then(() => mine);
    this.locks.set(unitId, turn);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(unitId) === turn) this.locks.delete(unitId);
    }
  }

  public pausedLanes(): ReadonlySet<string> {
    return this.paused;
  }

  /** The units an `after` order holds behind a predecessor, as of the last tick. */
  public heldUnits(): ReadonlySet<string> {
    return this.held;
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
    const lane = this.lane(laneName);
    const kind = lane.kind as { readonly attributeSchema?: ValueSchema };
    const schema = partial && kind.attributeSchema?.partial ? kind.attributeSchema.partial() : kind.attributeSchema;
    if (!schema) return attributes as JsonObject;
    const parsed = schema.safeParse(attributes);
    if (!parsed.success) throw new ControlError(`attributes do not fit kind "${lane.kind.name}": ${issuesOf(parsed)}`, 400);
    return parsed.data as JsonObject;
  }

  /** A decision a client hands in, checked against the schema of the halt the unit waits on. */
  public async decisionFor(unitId: string, decision: unknown): Promise<Json> {
    const record = await this.record(unitId);
    const attempt = record.unit.attempt;
    if (!attempt || attempt.status !== 'blocked' || attempt.blockedOn !== 'decision' || !attempt.halt) throw new ControlError(`unit "${unitId}" is not waiting on a decision`, 400);
    const schema = this.haltSchemaAt(record, attempt.step, attempt.halt);
    if (!schema) return decision as Json;
    const parsed = schema.safeParse(decision);
    if (!parsed.success) throw new ControlError(`decision does not fit halt "${attempt.halt}": ${issuesOf(parsed)}`, 400);
    return parsed.data as Json;
  }

  private haltSchemaAt(record: UnitRecord, step: string, halt: string): ValueSchema | undefined {
    const lane = this.lane(record.unit.lane);
    if (step.endsWith('/ceiling')) return lane.ceilingOf?.onExceed.name === halt ? (lane.ceilingOf.onExceed.decisionSchema as ValueSchema | undefined) : undefined;
    const node = lane.handlerDef ? nodeAt(lane.handlerDef.flow, step) : undefined;
    if (node?.type === 'halt') return node.halt.decisionSchema as ValueSchema | undefined;
    if (node?.type === 'step') return node.options.halts?.find((candidate) => candidate.name === halt)?.decisionSchema as ValueSchema | undefined;
    return undefined;
  }

  /** A signal payload a client hands in, checked against the signal's schema. */
  public payloadFor(laneName: string, signalName: string, payload: unknown): Json {
    const lane = this.lane(laneName);
    const entry = lane.reactions.find((candidate) => candidate.signal.name === signalName);
    if (!entry) throw new ControlError(`lane "${laneName}" has no reaction to "${signalName}"`, 400);
    const schema = entry.signal.payloadSchema as ValueSchema | undefined;
    if (!schema) return payload as Json;
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw new ControlError(`payload does not fit signal "${signalName}": ${issuesOf(parsed)}`, 400);
    return parsed.data as Json;
  }

  public async recordMemory(journal: JournalDef, draft: MemoryDraft): Promise<string> {
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
    return id;
  }

  /** Runs a command through its fixed runner: for triggers, custom operations, escalations and stop checks. */
  public async runExecutable(exec: Executable<unknown, unknown>, input: unknown, options: { readonly cwd?: string } = {}): Promise<ExecutableResult> {
    if (exec.entity !== 'command') throw new Error(`the engine can run a command here, not a ${exec.entity}`);
    const command = exec as CommandDef<unknown, unknown>;
    const runner = command.runnerChoice;
    if (!runner || runner.entity !== 'runner') throw new Error(`command "${command.name}" has no fixed runner for the engine to use`);
    const result = await runner.backend.exec({ argv: command.argvOf ? command.argvOf(input) : [], env: {}, ...(options.cwd ? { cwd: options.cwd } : {}) }, new AbortController().signal, this.resolver);
    const ok = command.acceptedExitCodes.includes(result.exitCode);
    if (ok && command.outputSchema) return { ok, exitCode: result.exitCode, output: command.outputSchema.parse(JSON.parse(result.stdout)) as Json };
    return { ok, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }

  private async runCheck(exec: Executable<void, unknown>, cwd: string): Promise<{ readonly ok: boolean; readonly detail: string }> {
    try {
      const result = await this.runExecutable(exec as Executable<unknown, unknown>, undefined, { cwd });
      return { ok: result.ok, detail: result.stderr?.trim() || result.stdout?.trim() || `exit ${result.exitCode}` };
    } catch (err) {
      return { ok: false, detail: message(err) };
    }
  }

  public unitView(record: UnitRecord): UnitView<unknown> {
    return unitViewOf(record, this.lane(record.unit.lane));
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
    const recording = recordingMetrics(this.metrics);
    const picked = policy.decide({ kind, seat, ...(current ? { current } : {}), peers, metrics: recording.metrics });
    const at = this.now();
    await this.append([{ type: 'policyDecision', attemptId, policy: policy.name, value: picked.name, reads: recording.reads, at }]);
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

  /** The one account of the seat's pool that can serve the model, when there is exactly one: a recovered call's account. */
  public soleAccount(seat: AnySeat, model: Model): Account | undefined {
    const driver = this.driverFor(model);
    const serving = accountsOf(seat).filter((account) => account.driver === model.driver && driver.serves(account));
    return serving.length === 1 ? serving[0] : undefined;
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
  public async recordFromRole(role: string, recorded: NonNullable<ModelResponse['recorded']>): Promise<void> {
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

  /** A guarded write needs the area exclusively; a shared lane lease on it is upgraded when nobody else holds it. */
  private async takeLease(attemptId: string, resource: string): Promise<boolean> {
    if (this.leasesHeld.get(attemptId)?.get(resource) === 'exclusive') return true;
    if (!(await this.ledger.takeLease(attemptId, resource, 'exclusive'))) return false;
    await this.append([{ type: 'leaseTaken', attemptId, resource, mode: 'exclusive', waitedMs: 0, at: this.now() }]);
    return true;
  }

  /** The events that close an attempt's leases, clocks and resume timer; they go in front of its `attemptEnded`. */
  private closingEvents(unitId: string, attemptId: string): LedgerEvent[] {
    const at = this.now();
    const leases: LedgerEvent[] = [...(this.leasesHeld.get(attemptId)?.keys() ?? [])].map((resource) => ({ type: 'leaseReleased', attemptId, resource, at }));
    const resume = this.resumeTimers.get(unitId);
    return [...leases, ...this.disarmEvents(unitId), ...(resume === undefined ? [] : [{ type: 'timerCleared' as const, timerId: resume, reason: 'disarmed' as const, at }])];
  }

  private disarmEvents(unitId: string): LedgerEvent[] {
    const at = this.now();
    return [...(this.clocks.get(unitId) ?? [])].map((timerId) => ({ type: 'timerCleared', timerId, reason: 'disarmed', at }));
  }

  private clockEvents(attemptId: string, unitId: string, step: string, clocks: { readonly escalateMinutes?: number; readonly timeoutMinutes?: number }): LedgerEvent[] {
    const at = this.now();
    const events: LedgerEvent[] = [];
    for (const [owner, minutes] of [
      ['escalate', clocks.escalateMinutes],
      ['timeout', clocks.timeoutMinutes],
    ] as const) {
      if (minutes === undefined) continue;
      events.push({ type: 'timerSet', timerId: `${attemptId}:${step}:${owner}`, unitId, owner: `${owner}:${step}`, fireAt: new Date(at.getTime() + minutes * 60_000), reason: 'armed', at });
    }
    return events;
  }

  private async attemptCost(attemptId: string): Promise<{ readonly costUsd: number; readonly equivalentUsd: number }> {
    let costUsd = 0;
    let equivalentUsd = 0;
    for await (const { event } of this.ledger.read({ attemptId, types: ['invocation'] })) {
      if (event.type !== 'invocation' || !event.ok) continue;
      costUsd += event.costUsd;
      equivalentUsd += event.equivalentUsd ?? event.costUsd;
    }
    return { costUsd, equivalentUsd };
  }

  private async endedEvent(attemptId: string, outcome: 'succeeded' | 'failed' | 'cancelled', extra: { readonly exit?: string; readonly detail?: string } = {}): Promise<LedgerEvent> {
    const cost = await this.attemptCost(attemptId);
    return { type: 'attemptEnded', attemptId, outcome, ...extra, costUsd: cost.costUsd, equivalentUsd: cost.equivalentUsd, at: this.now() };
  }

  private async releaseWorkspace(lane: AnyLane, attemptId: string): Promise<void> {
    const workspace = lane.handlerDef ? workspaceOf(lane.handlerDef.flow) : undefined;
    if (!workspace) return;
    await workspace.backend.release(attemptId).catch((err: unknown) => this.log(`workspace "${workspace.name}" failed to release attempt "${attemptId}": ${message(err)}`));
  }

  public async createUnit(lane: LaneAny, attrs: unknown, options: { readonly parentId?: string; readonly source: string }): Promise<string | undefined> {
    return (await this.createUnits(lane, [attrs], options))[0];
  }

  /**
   * Creates units in one append, each deduplicated against the lane's open units by key. A lane with a
   * creating store creates the record first and takes its key; one with a store that cannot create
   * accepts only keys the store already holds.
   */
  public async createUnits(lane: LaneAny, attrsList: readonly unknown[], options: { readonly parentId?: string; readonly source: string }): Promise<readonly (string | undefined)[]> {
    const def = this.lane(lane.name);
    const kind = def.kind as { readonly name: string; readonly keyOf?: (attrs: unknown) => string; readonly initialState?: State };
    const initial = kind.initialState!;
    const store = def.storeDef;
    const mapped = (def.storeMap?.states as Readonly<Record<string, string>> | undefined)?.[initial.name] ?? initial.name;
    const openByKey = new Map<string, string>();
    for (const record of await this.ledger.units({ lane: lane.name })) if (record.unit.position !== 'terminal') openByKey.set(record.unit.key, record.unit.id);
    const at = this.now();
    const events: LedgerEvent[] = [];
    const ids: (string | undefined)[] = [];
    for (const attrs of attrsList) {
      let key = kind.keyOf ? kind.keyOf(attrs) : undefined;
      const open = key === undefined ? undefined : openByKey.get(key);
      if (key !== undefined && open !== undefined) {
        events.push({ type: 'createSkipped', lane: lane.name, key, openUnitId: open, source: options.source, at });
        ids.push(undefined);
        continue;
      }
      if (store?.creates) {
        key = (await store.create(kind.name, mapped, attrs as JsonObject, this.resolver)).key;
      } else if (store) {
        if (key === undefined) throw new ControlError(`lane "${lane.name}" keeps its units in store "${store.name}", which cannot create; kind "${kind.name}" needs a key to find the record`, 400);
        if (!(await store.load(key, this.resolver))) throw new ControlError(`store "${store.name}" has no record "${key}" for lane "${lane.name}"`, 400);
      }
      key ??= randomUUID();
      const unitId = `unit-${randomUUID()}`;
      events.push(
        { type: 'unitCreated', unitId, lane: lane.name, kind: kind.name, key, ...(options.parentId ? { parentId: options.parentId } : {}), attributes: attrs as JsonObject, source: options.source, at },
        { type: 'transition', unitId, to: initial.name, position: initial.position, cause: `created:${options.source}`, at },
      );
      openByKey.set(key, unitId);
      ids.push(unitId);
    }
    if (events.length > 0) await this.append(events);
    return ids;
  }

  public async childrenOf(parentId: string, lane: LaneAny): Promise<readonly UnitRecord[]> {
    return (await this.ledger.units({ lane: lane.name })).filter((record) => record.unit.parentId === parentId);
  }

  /** An update through the control API applies at once (design §5.5). */
  public async updateAttributes(unitId: string, patch: unknown, by: string): Promise<void> {
    await this.withUnit(unitId, async () => {
      const record = await this.record(unitId);
      const checked = this.attributesFor(record.unit.lane, patch, true);
      await this.append([{ type: 'attributesUpdated', unitId, attributes: { ...record.unit.attributes, ...checked }, by, applied: true, at: this.now() }]);
    });
  }

  public async cancelUnit(unitId: string, reason: string, by: string): Promise<void> {
    const record = await this.record(unitId);
    await this.deliverSignal(record.unit.lane, record.unit.key, 'cancel', { reason }, by);
  }

  public async pauseLane(name: string, reason: string, by: string): Promise<void> {
    this.lane(name);
    await this.append([{ type: 'lanePaused', lane: name, reason, by, at: this.now() }]);
  }

  public async resumeLane(name: string, reason: string, by: string): Promise<void> {
    this.lane(name);
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

  /** Opens an attempt and walks it; a lane lease another attempt holds leaves the unit pending for the next tick. */
  public async startAttempt(unitId: string, serviceClass: 'expedite' | 'fixedDate' | 'standard' = 'standard'): Promise<WalkOutcome | undefined> {
    const opened = await this.withUnit(unitId, async () => {
      const record = await this.record(unitId);
      if (record.unit.attempt) throw new Error(`unit "${unitId}" already has an open attempt`);
      const lane = this.lane(record.unit.lane);
      const flow = lane.handlerDef!.flow;
      const attemptId = `attempt-${randomUUID()}`;
      const at = this.now();
      const leases: LedgerEvent[] = [];
      if (lane.leaseOf) {
        const lease = lane.leaseOf(unitViewOf(record, lane));
        if (!(await this.ledger.takeLease(attemptId, lease.resource.name, lease.mode))) {
          if (!this.leaseWaits.has(unitId)) this.leaseWaits.set(unitId, at);
          return false;
        }
        const since = this.leaseWaits.get(unitId);
        this.leaseWaits.delete(unitId);
        leases.push({ type: 'leaseTaken', attemptId, resource: lease.resource.name, mode: lease.mode, waitedMs: since ? Math.max(0, at.getTime() - since.getTime()) : 0, at });
      }
      await this.append([
        { type: 'demandGranted', lane: lane.name, unitId, serviceClass, at },
        { type: 'attemptStarted', unitId, attemptId, number: record.unit.attempts + 1, fromStep: flow.nodes[0]?.name ?? '', flow: flow.name, flowVersion: flowVersion(flow), serviceClass, at },
        ...leases,
      ]);
      return true;
    });
    return opened ? this.drive(unitId) : undefined;
  }

  /** Resumes an open attempt; `leading` events (a fired timer) land in the same append as the resumption. */
  public async resumeAttempt(unitId: string, resume?: Resume, leading: readonly LedgerEvent[] = []): Promise<WalkOutcome> {
    await this.withUnit(unitId, async () => {
      const record = await this.record(unitId);
      const attempt = record.unit.attempt;
      if (!attempt) throw new Error(`unit "${unitId}" has no open attempt`);
      if (attempt.status !== 'blocked') {
        if (leading.length > 0) await this.append(leading);
        return;
      }
      const timerId = this.resumeTimers.get(unitId);
      const firing = leading.some((event) => event.type === 'timerFired' && event.timerId === timerId);
      const at = this.now();
      await this.append([
        ...leading,
        { type: 'attemptResumed', attemptId: attempt.id, step: attempt.step, at },
        ...(timerId !== undefined && !firing ? [{ type: 'timerCleared' as const, timerId, reason: 'disarmed' as const, at }] : []),
      ]);
    });
    return this.drive(unitId, resume);
  }

  private async drive(unitId: string, resume?: Resume): Promise<WalkOutcome> {
    const record = await this.record(unitId);
    const attempt = record.unit.attempt;
    if (!attempt) throw new Error(`unit "${unitId}" has no open attempt`);
    const lane = this.lane(record.unit.lane);
    const flow = lane.handlerDef!.flow;
    const controller = new AbortController();
    this.aborts.set(attempt.id, controller);
    const driving = (async (): Promise<WalkOutcome> => {
      if (record.cursor && record.cursor.flowVersion !== flowVersion(flow)) {
        const outcome: WalkOutcome = { kind: 'blocked', step: attempt.step, on: 'definitionChanged', detail: `flow "${flow.name}" changed from ${record.cursor.flowVersion} to ${flowVersion(flow)}` };
        await this.settle(unitId, attempt.id, lane, outcome, controller);
        return outcome;
      }
      const memo = await buildMemo(this.ledger, flow, record, attempt.id);
      const outcome = await walk({ runtime: this, lane, flow, record, attemptId: attempt.id, memo, metrics: this.metrics, cancel: controller.signal, ...(resume ? { resume } : {}) });
      await this.settle(unitId, attempt.id, lane, outcome, controller);
      return outcome;
    })();
    this.drives.set(attempt.id, driving);
    try {
      return await driving;
    } finally {
      if (this.drives.get(attempt.id) === driving) this.drives.delete(attempt.id);
      if (this.aborts.get(attempt.id) === controller) this.aborts.delete(attempt.id);
    }
  }

  /** After a rewind aborted a running walk: wait for it to let go, then walk the attempt again from its new cursor. */
  private async redrive(unitId: string, attemptId: string): Promise<void> {
    await this.drives.get(attemptId)?.catch(() => undefined);
    await this.drive(unitId).catch((err: unknown) => this.log(`attempt "${attemptId}" failed to walk after a rewind: ${message(err)}`));
  }

  /** Records a walk's outcome, unless the attempt was ended or rewound from outside while it walked. */
  private async settle(unitId: string, attemptId: string, lane: AnyLane, outcome: WalkOutcome, controller: AbortController): Promise<void> {
    if (outcome.kind === 'cancelled') return;
    await this.withUnit(unitId, async () => {
      if (controller.signal.aborted) return;
      const record = await this.find(unitId);
      const attempt = record?.unit.attempt;
      if (!record || !attempt || attempt.id !== attemptId || attempt.status !== 'running') return;
      const at = this.now();
      if (outcome.kind === 'blocked') {
        await this.append([
          { type: 'attemptBlocked', attemptId, step: outcome.step, on: outcome.on, ...(outcome.halt ? { halt: outcome.halt.name } : {}), ...(outcome.ask ? { ask: outcome.ask } : {}), ...(outcome.detail ? { detail: outcome.detail } : {}), ...(outcome.facets ? { facets: outcome.facets } : {}), at },
          ...(outcome.resumeAt ? [{ type: 'timerSet' as const, timerId: `${attemptId}:${outcome.step}`, unitId, owner: `resume:${outcome.step}`, fireAt: outcome.resumeAt, reason: 'armed' as const, at }] : []),
          ...(outcome.on === 'decision' && outcome.clocks ? this.clockEvents(attemptId, unitId, outcome.step, outcome.clocks) : []),
        ]);
        return;
      }
      if (outcome.kind === 'exit') {
        const state = lane.handlerDef!.exits[outcome.exit];
        if (!state) throw new Error(`lane "${lane.name}" maps no state for exit "${outcome.exit}"`);
        await this.append([
          ...this.closingEvents(unitId, attemptId),
          await this.endedEvent(attemptId, 'succeeded', { exit: outcome.exit }),
          { type: 'transition', unitId, from: record.unit.state, to: state.name, position: state.position, ...(state.verdict ? { verdict: state.verdict } : {}), attemptId, cause: `exit:${outcome.exit}`, at },
          ...(await this.deferredPatches(unitId, record.unit.attributes)),
        ]);
        await this.settleTrackRecords(attemptId, true);
        await this.releaseWorkspace(lane, attemptId);
        return;
      }
      const failed = record.unit.failedAttempts + 1;
      const retry = lane.retryPolicy;
      const tries = retry?.tries ?? 0;
      if (failed <= tries) {
        const delay = (retry?.initialDelayMs ?? DEFAULT_RETRY_DELAY_MS) * (retry?.backoff === 'exponential' ? 2 ** (failed - 1) : 1);
        await this.append([
          ...this.closingEvents(unitId, attemptId),
          await this.endedEvent(attemptId, 'failed', { detail: outcome.error }),
          { type: 'retryScheduled', unitId, failedAttempts: failed, notBefore: new Date(at.getTime() + delay), at },
          ...(await this.deferredPatches(unitId, record.unit.attributes)),
        ]);
        await this.settleTrackRecords(attemptId, false);
        await this.releaseWorkspace(lane, attemptId);
        return;
      }
      const exhausted = retry?.exhausted as State | { readonly state: State; readonly reopenAfter: { readonly minutes?: number; readonly hours?: number; readonly days?: number } } | undefined;
      if (!exhausted) {
        await this.append([{ type: 'attemptBlocked', attemptId, step: outcome.step, on: 'stepFailure', detail: outcome.error, at }]);
        return;
      }
      const target = 'state' in exhausted ? exhausted.state : exhausted;
      const events: LedgerEvent[] = [
        ...this.closingEvents(unitId, attemptId),
        await this.endedEvent(attemptId, 'failed', { detail: outcome.error }),
        { type: 'transition', unitId, from: record.unit.state, to: target.name, position: target.position, ...(target.verdict ? { verdict: target.verdict } : {}), attemptId, cause: 'retry:exhausted', at },
      ];
      if ('state' in exhausted) {
        const after = exhausted.reopenAfter;
        const ms = (after.minutes ?? 0) * 60_000 + (after.hours ?? 0) * 3_600_000 + (after.days ?? 0) * 86_400_000;
        events.push({ type: 'timerSet', timerId: `${unitId}:reopen`, unitId, owner: 'reopen', fireAt: new Date(at.getTime() + ms), reason: 'armed', at });
      }
      await this.append([...events, ...(await this.deferredPatches(unitId, record.unit.attributes))]);
      await this.settleTrackRecords(attemptId, false);
      await this.releaseWorkspace(lane, attemptId);
    });
  }

  /** The deferred deltas not yet merged: every unapplied patch since the last merge. */
  private async pendingDeltas(unitId: string): Promise<JsonObject[]> {
    const deltas: JsonObject[] = [];
    for await (const { event } of this.ledger.read({ unitId, types: ['attributesUpdated'] })) {
      if (event.type !== 'attributesUpdated') continue;
      if (event.applied && event.by === MERGE_BY) deltas.length = 0;
      else if (!event.applied) deltas.push(event.attributes);
    }
    return deltas;
  }

  private async deferredPatches(unitId: string, current: JsonObject): Promise<LedgerEvent[]> {
    const deltas = await this.pendingDeltas(unitId);
    if (deltas.length === 0) return [];
    return [{ type: 'attributesUpdated', unitId, attributes: Object.assign({}, current, ...deltas) as JsonObject, by: MERGE_BY, applied: true, at: this.now() }];
  }

  private async blockedFacets(attemptId: string, step: string): Promise<readonly { readonly facet: string; readonly value: string }[]> {
    let facets: readonly { readonly facet: string; readonly value: string }[] = [];
    for await (const { event } of this.ledger.read({ attemptId, types: ['attemptBlocked'] })) {
      if (event.type === 'attemptBlocked' && event.step === step && event.facets) facets = event.facets;
    }
    return facets;
  }

  public async resolveHalt(unitId: string, decision: Json, by: string, resolvedBy: 'human' | 'timeout' = 'human', leading: readonly LedgerEvent[] = []): Promise<WalkOutcome> {
    const resume = await this.withUnit(unitId, async (): Promise<Resume> => {
      const record = await this.record(unitId);
      const attempt = record.unit.attempt;
      if (!attempt || attempt.status !== 'blocked' || attempt.blockedOn !== 'decision' || !attempt.halt) throw new ControlError(`unit "${unitId}" is not waiting on a decision`, 400);
      const facets = await this.blockedFacets(attempt.id, attempt.step);
      await this.append([
        ...leading,
        ...this.disarmEvents(unitId),
        { type: 'decisionRecorded', attemptId: attempt.id, step: attempt.step, halt: attempt.halt, decision, resolvedBy, by, facets, at: this.now() },
      ]);
      return { step: attempt.step, decision };
    });
    return this.resumeAttempt(unitId, resume);
  }

  /**
   * Delivers a signal to the lane's open unit of that key (design §3.12): `update` applies at once, or
   * as a deferred delta while a running attempt is past the reaction's gate; `rewind` moves the open
   * attempt back and walks it again; `enter` ends the attempt as cancelled and moves the unit.
   * Returns false when no open unit carries the key.
   */
  public async deliverSignal(laneName: string, key: string, signalName: string, payload: Json, source: string): Promise<boolean> {
    const lane = this.lane(laneName);
    const reaction = lane.reactions.find((entry) => entry.signal.name === signalName)?.reaction;
    if (!reaction) throw new ControlError(`lane "${laneName}" has no reaction to "${signalName}"`, 400);
    const open = (await this.ledger.units({ lane: laneName, key })).find((record) => record.unit.position !== 'terminal');
    if (!open) {
      await this.append([{ type: 'signalSkipped', lane: laneName, key, signal: signalName, source, at: this.now() }]);
      return false;
    }
    const unitId = open.unit.id;
    const flow = lane.handlerDef?.flow;
    const then = await this.withUnit(unitId, async (): Promise<(() => Promise<void>) | undefined> => {
      const record = await this.record(unitId);
      const attempt = record.unit.attempt;
      const at = this.now();
      const gated = reaction.at !== undefined && attempt !== undefined && !reaction.at.includes(topStep(attempt.step));
      const applied: ('update' | 'rewind' | 'enter')[] = [];
      const events: LedgerEvent[] = [];
      let current = record.unit.attributes;
      let then: (() => Promise<void>) | undefined;
      if (reaction.update) {
        if (attempt !== undefined && attempt.status === 'running' && gated) {
          const base = Object.assign({}, record.unit.attributes, ...(await this.pendingDeltas(unitId))) as JsonObject;
          const next = reaction.update(base, payload) as JsonObject;
          events.push({ type: 'attributesUpdated', unitId, attributes: differing(base, next), by: source, applied: false, at });
        } else {
          current = reaction.update(record.unit.attributes, payload) as JsonObject;
          events.push({ type: 'attributesUpdated', unitId, attributes: current, by: source, applied: true, at });
        }
        applied.push('update');
      }
      if (!gated && reaction.rewind && attempt && flow) {
        const superseded = supersededBy(flow, reaction.rewind, Object.keys(record.stepOutputs).map((key) => key.replace(/@\d+$/, '')));
        events.push({ type: 'attemptRewound', attemptId: attempt.id, from: attempt.step, to: reaction.rewind, signal: signalName, superseded, at });
        applied.push('rewind');
        if (attempt.status === 'running') {
          this.aborts.get(attempt.id)?.abort();
          then = async () => void this.redrive(unitId, attempt.id);
        } else {
          then = async () => void (await this.resumeAttempt(unitId));
        }
      }
      if (!gated && reaction.enter) {
        if (attempt) {
          this.aborts.get(attempt.id)?.abort();
          events.push(...this.closingEvents(unitId, attempt.id), await this.endedEvent(attempt.id, 'cancelled'));
        }
        events.push({ type: 'transition', unitId, from: record.unit.state, to: reaction.enter.name, position: reaction.enter.position, ...(reaction.enter.verdict ? { verdict: reaction.enter.verdict } : {}), ...(attempt ? { attemptId: attempt.id } : {}), cause: `signal:${signalName}`, at });
        if (attempt) events.push(...(await this.deferredPatches(unitId, current)));
        applied.push('enter');
        then = attempt ? () => this.releaseWorkspace(lane, attempt.id) : undefined;
      }
      events.push({ type: 'signalDelivered', unitId, signal: signalName, payload, source, applied, ...(gated && attempt ? { gatedAtStep: attempt.step } : {}), at });
      await this.append(events);
      return then;
    });
    if (then) await then();
    return true;
  }

  public async recover(unitId: string, action: 'restartFromTop' | 'abandon' | 'continue', by: string): Promise<WalkOutcome | undefined> {
    const then = await this.withUnit(unitId, async (): Promise<() => Promise<WalkOutcome | undefined>> => {
      const record = await this.record(unitId);
      const attempt = record.unit.attempt;
      if (!attempt || attempt.status !== 'blocked') throw new ControlError(`unit "${unitId}" has no blocked attempt to recover`, 400);
      const at = this.now();
      const recovered: LedgerEvent = { type: 'attemptRecovered', attemptId: attempt.id, action, by, at };
      if (action === 'continue') {
        await this.append([recovered]);
        return () => this.resumeAttempt(unitId, { step: attempt.step });
      }
      const lane = this.lane(record.unit.lane);
      const events: LedgerEvent[] = [recovered, ...this.closingEvents(unitId, attempt.id), await this.endedEvent(attempt.id, 'cancelled')];
      if (action === 'abandon') {
        const cancel = lane.reactions.find((entry) => entry.signal.name === 'cancel')?.reaction;
        if (cancel?.enter) {
          events.push({ type: 'transition', unitId, from: record.unit.state, to: cancel.enter.name, position: cancel.enter.position, ...(cancel.enter.verdict ? { verdict: cancel.enter.verdict } : {}), attemptId: attempt.id, cause: `recover:${action}`, at });
        }
      }
      events.push(...(await this.deferredPatches(unitId, record.unit.attributes)));
      await this.append(events);
      await this.releaseWorkspace(lane, attempt.id);
      return action === 'restartFromTop' ? () => this.startAttempt(unitId) : async () => undefined;
    });
    return then();
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
  private async fireClock(timer: DueTimer, fired: LedgerEvent): Promise<void> {
    const separator = timer.owner.indexOf(':');
    const kind = timer.owner.slice(0, separator);
    const step = timer.owner.slice(separator + 1);
    const record = await this.find(timer.unitId);
    const attempt = record?.unit.attempt;
    if (!record || !attempt || attempt.status !== 'blocked' || attempt.blockedOn !== 'decision' || attempt.step !== step || !attempt.halt) {
      await this.append([fired]);
      return;
    }
    const options = this.haltOptionsAt(record);
    if (kind === 'escalate' && options?.escalate) {
      await this.append([fired, { type: 'haltEscalated', attemptId: attempt.id, step, halt: attempt.halt, at: this.now() }]);
      await this.runExecutable(options.escalate.run as Executable<unknown, unknown>, undefined);
      return;
    }
    if (kind === 'timeout' && options?.timeout) {
      const decision = options.timeout.decide(await this.flowCtx(record)) as Json;
      await this.resolveHalt(timer.unitId, decision, 'timeout', 'timeout', [fired]);
      return;
    }
    await this.append([fired]);
  }

  /** The `after` order of each lane: a unit waits behind the open unit its key names; a failed predecessor parks it (design §3.12). */
  private async applyOrderHolds(): Promise<void> {
    const held = new Set<string>();
    for (const lane of this.harness.laneList as readonly AnyLane[]) {
      const order = lane.order;
      if (!order) continue;
      const units = await this.ledger.units({ lane: lane.name });
      const latestByKey = new Map<string, UnitRecord>();
      for (const record of units) {
        const known = latestByKey.get(record.unit.key);
        if (!known || (known.unit.position === 'terminal' && record.unit.position !== 'terminal') || (known.unit.position === 'terminal' && record.unit.createdAt > known.unit.createdAt)) latestByKey.set(record.unit.key, record);
      }
      for (const record of units) {
        if (record.unit.position !== 'pending' || record.unit.attempt !== undefined) continue;
        const predecessorKey = order.key(record.unit.attributes);
        if (predecessorKey === undefined || predecessorKey === record.unit.key) continue;
        const predecessor = latestByKey.get(predecessorKey);
        if (!predecessor) continue;
        const at = this.now();
        if (predecessor.unit.position === 'terminal') {
          if (predecessor.unit.verdict === 'failure') {
            const target = order.onPredecessorFailed as State;
            await this.append([{ type: 'transition', unitId: record.unit.id, from: record.unit.state, to: target.name, position: target.position, ...(target.verdict ? { verdict: target.verdict } : {}), cause: `order:${predecessorKey}`, at }]);
          }
          continue;
        }
        held.add(record.unit.id);
        if (this.orderHolds.get(record.unit.id) !== predecessorKey) {
          await this.append([{ type: 'orderHeld', unitId: record.unit.id, predecessorKey, reason: `waits for "${predecessorKey}", which is ${predecessor.unit.state}`, at }]);
        }
      }
    }
    this.held = held;
  }

  public async tick(): Promise<void> {
    const now = this.now();
    if (this.ledgerMetrics) await this.ledgerMetrics.refresh();
    for (const timer of await this.ledger.dueTimers(now)) {
      const fired: LedgerEvent = { type: 'timerFired', timerId: timer.timerId, unitId: timer.unitId, at: now };
      if (timer.owner.startsWith('resume:')) {
        const step = timer.owner.slice('resume:'.length);
        const attempt = (await this.find(timer.unitId))?.unit.attempt;
        if (attempt?.status === 'blocked' && attempt.step === step && attempt.blockedOn !== 'decision') await this.resumeAttempt(timer.unitId, { step }, [fired]);
        else await this.append([fired]);
      } else if (timer.owner === 'reopen') {
        const record = await this.find(timer.unitId);
        if (!record || record.unit.position === 'terminal' || record.unit.attempt) {
          await this.append([fired]);
          continue;
        }
        const initial = (this.lane(record.unit.lane).kind as { readonly initialState?: State }).initialState!;
        await this.append([fired, { type: 'transition', unitId: timer.unitId, from: record.unit.state, to: initial.name, position: initial.position, cause: 'reopen', at: now }]);
      } else if (timer.owner.startsWith('escalate:') || timer.owner.startsWith('timeout:')) {
        await this.fireClock(timer, fired);
      } else {
        await this.append([fired]);
      }
    }
    for (const record of await this.ledger.units({ attemptStatus: ['blocked'] })) {
      const attempt = record.unit.attempt;
      if (attempt?.blockedOn !== 'children') continue;
      const lane = this.lane(record.unit.lane);
      const node = nodeAt(lane.handlerDef!.flow, attempt.step);
      if (node?.type !== 'spawn') continue;
      const children = await this.childrenOf(record.unit.id, node.lane);
      if (children.length > 0 && children.every((child) => child.unit.position === 'terminal')) await this.resumeAttempt(record.unit.id, { step: attempt.step });
    }
    await this.triggerEngine.process();
    await this.applyOrderHolds();
    for (const grant of await computeDemand(this)) {
      await this.startAttempt(grant.unitId, grant.serviceClass);
    }
    await this.triggerEngine.process();
  }
}
