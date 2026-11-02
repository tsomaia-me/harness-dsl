import { z } from 'zod';
import type { CommandDef, CommandResult } from '../dsl/commands.js';
import type { Executable } from '../dsl/executables.js';
import type { FlowCtx, FlowDef, FlowNode, HaltOptions, StepOptions } from '../dsl/flows.js';
import type { HaltDef } from '../dsl/halts.js';
import type { JobDef, JobHandle, JobPoll } from '../dsl/jobs.js';
import type { LaneDef } from '../dsl/lanes.js';
import type { RunnerPolicyDef } from '../dsl/policies.js';
import type { RoleDef } from '../dsl/roles.js';
import type { RunnerDef, WorkspaceDef } from '../dsl/runners.js';
import type { ChildResult, UnitView } from '../dsl/views.js';
import type { Account, KindRef, LedgerEvent, MemoryItem, Metrics, Model, ModelDriver, ModelRequest, ModelResponse, State, StoredFacetValue, UnitRecord } from '../kernel/index.js';
import { AccountRefusedError } from '../kernel/quota.js';
import type { Json, JsonObject } from '../kernel/refs.js';
import { address, type Frame } from './address.js';
import type { Memo } from './memo.js';
import { recordingMetrics } from './metrics.js';
import type { Recalled } from './recall.js';
import type { QuotaEventBody, Runtime } from './runtime.js';
import { modelsOf, type AnySeat } from './seats.js';

/** How long a seat step waits before asking the driver again about a session that is still running. */
export const SESSION_POLL_MS = 60_000;
/** The delay before a step's first retry when its policy names none. */
export const DEFAULT_STEP_RETRY_DELAY_MS = 60_000;

export type BlockReasonOfWalk = 'decision' | 'timer' | 'children' | 'job' | 'interrupted' | 'budget' | 'definitionChanged';

export type WalkOutcome =
  | { readonly kind: 'exit'; readonly exit: string }
  | {
      readonly kind: 'blocked';
      readonly step: string;
      readonly on: BlockReasonOfWalk;
      readonly halt?: HaltDef<string, unknown>;
      readonly ask?: string;
      readonly facets?: readonly StoredFacetValue[];
      readonly detail?: string;
      readonly resumeAt?: Date;
      readonly clocks?: { readonly escalateMinutes?: number; readonly timeoutMinutes?: number };
    }
  | { readonly kind: 'failed'; readonly step: string; readonly error: string }
  | { readonly kind: 'cancelled' };

class Blocked {
  public constructor(public readonly outcome: Extract<WalkOutcome, { kind: 'blocked' }>) {}
}

class StepFailed {
  public constructor(public readonly outcome: Extract<WalkOutcome, { kind: 'failed' }>) {}
}

class Exited {
  public constructor(public readonly outcome: Extract<WalkOutcome, { kind: 'exit' }>) {}
}

class Cancelled {}

export interface WalkInput {
  readonly runtime: Runtime;
  readonly lane: LaneDef<unknown, State, unknown, string>;
  readonly flow: FlowDef<unknown, unknown, unknown, string, string>;
  readonly record: UnitRecord;
  readonly attemptId: string;
  readonly memo: Memo;
  readonly metrics: Metrics;
  readonly cancel: AbortSignal;
  readonly resume?: { readonly step: string; readonly decision?: Json };
}

type AnyCtx = FlowCtx<unknown, unknown, Record<string, unknown>>;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isControl(err: unknown): boolean {
  return err instanceof Blocked || err instanceof StepFailed || err instanceof Exited || err instanceof Cancelled;
}

export async function walk(input: WalkInput): Promise<WalkOutcome> {
  const walker = new Walker(input);
  try {
    await walker.run(input.flow.nodes, []);
    return { kind: 'failed', step: walker.current, error: `flow "${input.flow.name}" reached no exit` };
  } catch (err) {
    if (err instanceof Exited) return err.outcome;
    if (err instanceof Blocked) return err.outcome;
    if (err instanceof StepFailed) return err.outcome;
    if (err instanceof Cancelled) return { kind: 'cancelled' };
    throw err;
  }
}

class Walker {
  private readonly steps: Record<string, unknown> = {};
  private readonly carries: Record<string, unknown> = {};
  private readonly finished = new Set<string>();
  private record: UnitRecord;
  private iteration = 0;
  private now: Date;
  private workspaceDir: string | undefined;
  private spentUsd = 0;
  public current = '';

  public constructor(private readonly input: WalkInput) {
    this.now = input.record.unit.attempt?.startedAt ?? input.memo.lastAt;
    this.record = input.record;
  }

  private get runtime(): Runtime {
    return this.input.runtime;
  }

  private unitView(): UnitView<unknown> {
    return this.runtime.unitView(this.record);
  }

  private ctx(): AnyCtx {
    return { unit: this.unitView(), params: this.input.lane.handlerDef?.params, steps: { ...this.carries, ...this.steps }, now: this.now, iteration: this.iteration };
  }

  private async append(events: readonly LedgerEvent[]): Promise<void> {
    if (this.input.cancel.aborted) throw new Cancelled();
    await this.runtime.append(events);
  }

  /** User code and executables fail the step they belong to; the engine's own errors escape (design §5.2). */
  private async guarded<T>(addr: string, what: string, fn: () => T | Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (isControl(err)) throw err;
      throw new StepFailed({ kind: 'failed', step: addr, error: `${what} failed: ${message(err)}` });
    }
  }

  /** Marks the step started; a step the attempt resumed at is marked again, so a later crash in it reads as an interruption. */
  private async visit(addr: string, atIteration: number): Promise<void> {
    const memo = this.input.memo;
    const visited = memo.visited.get(addr);
    if (visited) this.now = visited;
    if (memo.invocations.get(addr)?.started && !memo.resumedAt.has(addr)) return;
    const at = this.runtime.now();
    if (!visited) this.now = at;
    await this.append([{ type: 'stepStarted', attemptId: this.input.attemptId, step: addr, iteration: atIteration, at }]);
  }

  /** An interruption is recorded once: a later poll of the same interrupted step adds nothing. */
  private async recordInterruption(addr: string): Promise<void> {
    if (this.input.memo.interruptedAt.has(addr)) return;
    await this.append([{ type: 'attemptInterrupted', attemptId: this.input.attemptId, step: addr, holder: this.runtime.holder, at: this.runtime.now() }]);
  }

  /** A step the harness was running when it died: interrupted on record, or started and neither finished, blocked at nor resumed at. */
  private interrupted(addr: string): boolean {
    const memo = this.input.memo;
    if (memo.interruptedAt.has(addr)) return true;
    const recorded = memo.invocations.get(addr);
    return recorded?.started === true && !recorded.ended && !memo.blockedAt.has(addr) && !memo.resumedAt.has(addr);
  }

  private async finish(addr: string, atIteration: number, ok: boolean, output: Json | undefined, startedAt: Date, extra: readonly LedgerEvent[] = []): Promise<void> {
    const at = this.runtime.now();
    this.finished.add(addr);
    await this.append([{ type: 'stepEnded', attemptId: this.input.attemptId, step: addr, iteration: atIteration, ok, output, durationMs: Math.max(0, at.getTime() - startedAt.getTime()), at }, ...extra]);
  }

  public async run(nodes: readonly FlowNode[], frames: readonly Frame[]): Promise<void> {
    for (const node of nodes) await this.node(node, frames);
  }

  private async node(node: FlowNode, frames: readonly Frame[]): Promise<void> {
    const here = [...frames, { name: node.name }];
    const addr = address(here);
    const iteration = this.iteration;
    this.current = addr;
    this.record = (await this.runtime.find(this.input.record.unit.id)) ?? this.record;
    switch (node.type) {
      case 'exit': {
        if (node.when && !(await this.guarded(addr, `the condition of exit "${node.name}"`, () => node.when!(this.ctx())))) return;
        throw new Exited({ kind: 'exit', exit: node.name });
      }
      case 'step': {
        const memo = this.input.memo.outputs.get(addr);
        if (memo !== undefined) {
          this.steps[node.name] = memo;
          return;
        }
        this.steps[node.name] = await this.stepWithRetry(node, addr, iteration);
        return;
      }
      case 'halt': {
        this.steps[node.name] = await this.halt(node, addr, iteration);
        return;
      }
      case 'read': {
        const memo = this.input.memo.reads.get(addr);
        if (memo !== undefined) {
          this.steps[node.name] = memo;
          return;
        }
        const startedAt = this.runtime.now();
        await this.visit(addr, iteration);
        const query = node.query ? await this.guarded(addr, `the query of read "${node.name}"`, () => node.query!(this.ctx())) : {};
        const recording = recordingMetrics(this.input.metrics);
        const value = node.metric.measure === 'rate' ? recording.metrics.rate(node.metric as never, query) : recording.metrics.total(node.metric as never, query);
        const read = recording.reads[0] ?? { metric: node.metric.name, dimensions: {}, value: 'rate' in value ? value.rate : value.total, samples: value.samples };
        await this.append([{ type: 'metricRead', attemptId: this.input.attemptId, step: addr, iteration, read, at: this.runtime.now() }]);
        await this.finish(addr, iteration, true, value as unknown as Json, startedAt);
        this.steps[node.name] = value;
        return;
      }
      case 'spawn': {
        const memo = this.input.memo.outputs.get(addr);
        if (memo !== undefined) {
          this.steps[node.name] = memo;
          return;
        }
        this.steps[node.name] = await this.spawn(node, addr, iteration);
        return;
      }
      case 'wait': {
        const memo = this.input.memo.outputs.get(addr);
        if (memo !== undefined) {
          this.steps[node.name] = new Date(memo as string);
          return;
        }
        const startedAt = this.runtime.now();
        if (this.input.resume?.step === addr) {
          await this.finish(addr, iteration, true, this.runtime.now().toISOString(), startedAt);
          this.steps[node.name] = this.runtime.now();
          return;
        }
        await this.visit(addr, iteration);
        throw new Blocked({ kind: 'blocked', step: addr, on: 'timer', resumeAt: new Date(this.now.getTime() + node.ms) });
      }
      case 'when': {
        if (await this.guarded(addr, `the condition of "${node.name}"`, () => node.predicate(this.ctx()))) await this.run(node.nodes, here);
        return;
      }
      case 'parallel': {
        const memo = this.input.memo.outputs.get(addr);
        if (memo !== undefined) {
          this.steps[node.name] = memo;
          return;
        }
        this.steps[node.name] = await this.parallel(node, here, addr, iteration);
        return;
      }
      case 'loop': {
        await this.loop(node, here);
        return;
      }
    }
  }

  /** Every branch runs to its own end before the parallel settles; one block or failure is then the node's (design §3.11). */
  private async parallel(node: Extract<FlowNode, { type: 'parallel' }>, here: readonly Frame[], addr: string, iteration: number): Promise<JsonObject> {
    const startedAt = this.runtime.now();
    await this.visit(addr, iteration);
    const settled = await Promise.allSettled(
      Object.entries(node.branches).map(async ([key, branch]) => {
        const branchAddr = address([...here, { name: key }]);
        const stepNode: Extract<FlowNode, { type: 'step' }> =
          'exec' in branch
            ? { type: 'step', name: key, exec: branch.exec as Executable<unknown, unknown>, input: branch.input as (ctx: AnyCtx) => unknown, options: {} }
            : { type: 'step', name: key, exec: branch as Executable<unknown, unknown>, options: {} };
        const recorded = this.input.memo.outputs.get(branchAddr);
        return [key, recorded !== undefined ? recorded : await this.stepWithRetry(stepNode, branchAddr, iteration)] as const;
      }),
    );
    const failures = settled.filter((entry): entry is PromiseRejectedResult => entry.status === 'rejected').map((entry) => entry.reason as unknown);
    const first = failures.find((err) => err instanceof Cancelled) ?? failures.find((err) => err instanceof Blocked) ?? failures.find((err) => err instanceof StepFailed) ?? failures[0];
    if (first !== undefined) throw first;
    const output = Object.fromEntries(settled.map((entry) => (entry as PromiseFulfilledResult<readonly [string, unknown]>).value)) as JsonObject;
    await this.finish(addr, iteration, true, output, startedAt);
    return output;
  }

  private async loop(node: Extract<FlowNode, { type: 'loop' }>, here: readonly Frame[]): Promise<void> {
    const span = node.bounds.span ?? 'attempt';
    const addr = address(here);
    const recorded = this.input.memo.loops.get(node.name);
    let iteration = recorded?.iteration ?? 0;
    let carry: unknown = recorded?.carry ?? node.carry?.initial;
    const outer = this.iteration;
    while (true) {
      const max = typeof node.bounds.max === 'function' ? await this.guarded(addr, `the bound of loop "${node.name}"`, () => (node.bounds.max as (ctx: AnyCtx) => number)(this.ctx())) : node.bounds.max;
      if (max !== undefined && iteration >= max) break;
      if (recorded === undefined || recorded.iteration !== iteration) {
        await this.append([{ type: 'loopIteration', unitId: this.input.record.unit.id, attemptId: this.input.attemptId, loop: node.name, iteration, span, ...(node.carry ? { carry: carry as Json } : {}), at: this.runtime.now() }]);
      }
      if (node.carry) this.carries[node.name] = carry;
      this.iteration = iteration;
      const frames = [...here.slice(0, -1), { name: node.name, iteration }];
      await this.run(node.nodes, frames);
      if (node.bounds.until && (await this.guarded(addr, `the until of loop "${node.name}"`, () => node.bounds.until!(this.ctx())))) break;
      iteration += 1;
      if (node.carry) carry = await this.guarded(addr, `the carry of loop "${node.name}"`, () => node.carry!.next(this.ctx()));
    }
    this.iteration = outer;
  }

  /** A failed step retries under its own policy before it is the attempt's failure (design §3.11 `retry`). */
  private async stepWithRetry(node: Extract<FlowNode, { type: 'step' }>, addr: string, iteration: number): Promise<unknown> {
    try {
      return await this.step(node, addr, iteration);
    } catch (err) {
      if (!(err instanceof StepFailed)) throw err;
      if (!this.finished.has(addr)) await this.finish(addr, iteration, false, undefined, this.now);
      const retry = node.options.retry;
      const failures = (this.input.memo.failures.get(addr) ?? 0) + 1;
      if (!retry || failures > retry.tries) throw err;
      const delay = (retry.initialDelayMs ?? DEFAULT_STEP_RETRY_DELAY_MS) * (retry.backoff === 'exponential' ? 2 ** (failures - 1) : 1);
      throw new Blocked({ kind: 'blocked', step: addr, on: 'timer', detail: `retry ${failures} of ${retry.tries}: ${err.outcome.error}`, resumeAt: new Date(this.runtime.now().getTime() + delay) });
    }
  }

  private async step(node: Extract<FlowNode, { type: 'step' }>, addr: string, iteration: number): Promise<unknown> {
    const exec = node.exec;
    const input = node.input ? await this.guarded(addr, `the input of step "${node.name}"`, () => node.input!(this.ctx())) : undefined;
    switch (exec.entity) {
      case 'command':
        return this.command(exec as CommandDef<unknown, unknown>, input, addr, iteration);
      case 'seat':
        return this.seat(exec as AnySeat, input, node.options, addr, iteration);
      case 'job':
        return this.job(exec as JobDef<unknown, unknown>, input, addr, iteration);
      default:
        throw new StepFailed({ kind: 'failed', step: addr, error: `step "${addr}" executes a ${exec.entity}, which the engine cannot run` });
    }
  }

  private async command(command: CommandDef<unknown, unknown>, input: unknown, addr: string, iteration: number, extra: (output: Json) => readonly LedgerEvent[] = () => []): Promise<unknown> {
    const recorded = this.input.memo.invocations.get(addr);
    const interrupted = this.interrupted(addr);
    if (interrupted && this.input.resume?.step === addr) {
      if (command.outputSchema) throw new StepFailed({ kind: 'failed', step: addr, error: `command "${command.name}" was continued after an interruption but its output cannot be made up; restart the attempt or abandon it` });
      const output: CommandResult = { exitCode: 0, stdout: '', stderr: '' };
      await this.finish(addr, iteration, true, output as unknown as Json, this.runtime.now(), extra(output as unknown as Json));
      return output;
    }
    if (interrupted) {
      await this.recordInterruption(addr);
      if (command.effectKind === 'unrepeatable') {
        throw new Blocked({ kind: 'blocked', step: addr, on: 'interrupted', detail: `command "${command.name}" is unrepeatable and was running when the harness stopped` });
      }
      if (command.effectKind === 'external' && command.detect) {
        const runner = await this.pickRunner(command, addr);
        const happened = await this.guarded(addr, `the detect of command "${command.name}"`, () => command.detect!({ input, exec: (argv) => this.exec(runner, argv) }));
        if (happened) {
          const output: CommandResult = { exitCode: 0, stdout: '', stderr: '' };
          await this.finish(addr, iteration, true, output as unknown as Json, this.runtime.now(), extra(output as unknown as Json));
          return output;
        }
      }
    }
    const startedAt = this.runtime.now();
    await this.visit(addr, iteration);
    const runner = await this.pickRunner(command, addr);
    const argv = await this.guarded(addr, `the argv of command "${command.name}"`, () => (command.argvOf ? command.argvOf(input) : []));
    const result = await this.guarded(addr, `command "${command.name}"`, () => this.exec(runner, argv));
    const ok = command.acceptedExitCodes.includes(result.exitCode);
    await this.append([{ type: 'invocation', attemptId: this.input.attemptId, step: addr, number: (recorded?.number ?? 0) + 1, executable: command.name, runner: runner.name, viaJob: false, ok, costUsd: 0, durationMs: result.durationMs, at: this.runtime.now() }]);
    if (!ok) throw new StepFailed({ kind: 'failed', step: addr, error: `command "${command.name}" exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}` });
    let output: unknown = { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    if (command.outputSchema) {
      try {
        output = command.outputSchema.parse(JSON.parse(result.stdout));
      } catch (err) {
        throw new StepFailed({ kind: 'failed', step: addr, error: `command "${command.name}" produced output that fails its schema: ${message(err)}` });
      }
    }
    await this.finish(addr, iteration, true, output as Json, startedAt, extra(output as Json));
    return output;
  }

  private async pickRunner(command: CommandDef<unknown, unknown>, addr: string): Promise<RunnerDef> {
    const choice = command.runnerChoice;
    if (!choice) throw new StepFailed({ kind: 'failed', step: addr, error: `command "${command.name}" has no runner` });
    if (choice.entity === 'runner') return choice;
    const policy = choice as RunnerPolicyDef;
    const recording = recordingMetrics(this.input.metrics);
    const runner = await this.guarded(addr, `policy "${policy.name}"`, () => policy.decide({ candidates: policy.candidates, unit: this.unitView(), metrics: recording.metrics }));
    await this.append([{ type: 'policyDecision', attemptId: this.input.attemptId, policy: policy.name, value: runner.name, reads: recording.reads, at: this.runtime.now() }]);
    return runner;
  }

  /** The attempt's workspace: the first one a step of the flow declares, prepared once per attempt. */
  private async workspacePath(): Promise<string | undefined> {
    if (this.workspaceDir !== undefined) return this.workspaceDir || undefined;
    const workspace = workspaceOf(this.input.flow);
    this.workspaceDir = workspace ? (await this.guarded(this.current, `workspace "${workspace.name}"`, () => workspace.backend.prepare(this.input.attemptId))).path : '';
    return this.workspaceDir || undefined;
  }

  /** A command runs in the attempt's workspace when the flow has one, else where the harness runs. */
  private async exec(runner: RunnerDef, argv: readonly string[]): Promise<CommandResult & { readonly durationMs: number }> {
    const cwd = await this.workspacePath();
    return runner.backend.exec({ argv, env: {}, ...(cwd ? { cwd } : {}) }, this.input.cancel, this.runtime.resolver);
  }

  private kindRef(): KindRef {
    return { entity: 'kind', name: this.input.record.unit.kind };
  }

  private async recallFor(role: RoleDef<unknown, unknown>, options: StepOptions): Promise<Recalled> {
    const recalled = await this.runtime.recallFor({
      kind: this.input.record.unit.kind,
      role: role.name,
      resources: options.guard?.leases?.all.map((resource) => resource.name) ?? [],
      facets: [],
    });
    await this.append(recalled.decisions.map((decision) => ({ type: 'policyDecision' as const, attemptId: this.input.attemptId, policy: decision.policy, value: [...decision.ids], at: this.runtime.now() })));
    return recalled;
  }

  private request(seat: AnySeat, model: Model, account: Account, input: unknown, memory: readonly MemoryItem[], options: StepOptions, key: string, extra: Pick<ModelRequest, 'resume' | 'workspacePath' | 'guard'> = {}): ModelRequest {
    const role = seat.roleDef!;
    return {
      seat: seat.name,
      model: model.id,
      account,
      role: { name: role.name, intents: role.intentList, prompt: role.render ? role.render(input) : '' },
      input: input as Json,
      memory,
      halts: (options.halts ?? []).map((halt) => ({ name: halt.name, decisionSchema: halt.decisionSchema ? (z.toJSONSchema(halt.decisionSchema) as Json) : {} })),
      outputSchema: role.outputSchema ? (z.toJSONSchema(role.outputSchema) as Json) : {},
      idempotencyKey: key,
      cancel: this.input.cancel,
      ...extra,
    };
  }

  private guardFor(seat: AnySeat, driver: ModelDriver, options: StepOptions, workspacePath: string, key: string, addr: string): NonNullable<ModelRequest['guard']> {
    if (!driver.guardProtocol) throw new StepFailed({ kind: 'failed', step: addr, error: `driver "${driver.name}" has no guard protocol for the guarded step "${addr}"` });
    return this.runtime.registerGuard(key, {
      attemptId: this.input.attemptId,
      seat: seat.name,
      protocol: driver.guardProtocol,
      workspacePath,
      areas: options.workspace?.areas ?? {},
      leases: options.guard?.leases !== undefined,
      ...(options.guard?.beforeStop ? { beforeStop: options.guard.beforeStop } : {}),
    });
  }

  private usageOf(response: ModelResponse): QuotaEventBody[] {
    const at = this.runtime.now();
    return [
      { type: 'consumed', tokens: response.tokens, costUsd: response.costUsd ?? 0, at },
      ...(response.windows ?? []).map((window) => ({ type: 'windowObserved' as const, window: window.window, ...(window.kind ? { kind: window.kind } : {}), utilization: window.utilization, resetsAt: window.resetsAt, at })),
      ...(response.cooldownUntil ? [{ type: 'cooldown' as const, until: response.cooldownUntil, reason: 'reported by the driver', at }] : []),
    ];
  }

  private invocationEvent(seat: AnySeat, model: Model, account: Account | undefined, addr: string, number: number, viaJob: boolean, response: ModelResponse | undefined, startedAt: Date, memory: readonly string[]): LedgerEvent {
    const at = this.runtime.now();
    return {
      type: 'invocation',
      attemptId: this.input.attemptId,
      step: addr,
      number,
      executable: seat.name,
      seat: seat.name,
      model: model.name,
      ...(account ? { account: account.name } : {}),
      viaJob,
      ok: response !== undefined,
      costUsd: response?.costUsd ?? 0,
      ...(response?.equivalentUsd !== undefined ? { equivalentUsd: response.equivalentUsd } : {}),
      ...(response ? { tokens: response.tokens } : {}),
      ...(response?.sessionId ? { sessionId: response.sessionId } : {}),
      ...(memory.length > 0 ? { memory: [...memory] } : {}),
      durationMs: Math.max(0, at.getTime() - startedAt.getTime()),
      at,
    };
  }

  /**
   * Runs one call on an account of the seat's pool. An account that refuses the call gets its
   * cooldown and windows on the partition, a failed invocation on the ledger, and the next account
   * tries; no account at all blocks the step on budget until the soonest refusal, cooldown or reset.
   */
  private async withAccount<T>(seat: AnySeat, model: Model, addr: string, viaJob: boolean, startNumber: number, call: (account: Account) => Promise<T>): Promise<{ readonly account: Account; readonly number: number; readonly result: T }> {
    const excluded = new Set<string>();
    let number = startNumber;
    let soonest: Date | undefined;
    for (;;) {
      const acquired = await this.runtime.acquireAccount(seat, model, excluded, this.input.attemptId);
      if (!acquired.account) {
        const resumeAt = acquired.resumeAt ?? soonest;
        throw new Blocked({ kind: 'blocked', step: addr, on: 'budget', detail: acquired.detail, ...(resumeAt ? { resumeAt } : {}) });
      }
      const account = acquired.account;
      number += 1;
      const startedAt = this.runtime.now();
      try {
        return { account, number, result: await call(account) };
      } catch (err) {
        if (this.input.cancel.aborted) throw new Cancelled();
        const at = this.runtime.now();
        if (!(err instanceof AccountRefusedError)) {
          await this.append([this.invocationEvent(seat, model, account, addr, number, viaJob, undefined, startedAt, [])]);
          throw new StepFailed({ kind: 'failed', step: addr, error: `seat "${seat.name}" failed: ${message(err)}` });
        }
        if (!soonest || err.until < soonest) soonest = err.until;
        await this.runtime.quotaEvents(account, [
          { type: 'cooldown', until: err.until, reason: `${err.refusal}: ${err.message.slice(0, 500)}`, at },
          ...err.windows.map((window) => ({ type: 'windowObserved' as const, window: window.window, ...(window.kind ? { kind: window.kind } : {}), utilization: window.utilization, resetsAt: window.resetsAt, at })),
        ]);
        await this.append([this.invocationEvent(seat, model, account, addr, number, viaJob, undefined, startedAt, [])]);
        excluded.add(account.name);
      }
    }
  }

  /** The lane's cost ceiling asks its halt once per attempt, before the call that would cross it (design §3.12). */
  private async ceiling(addr: string): Promise<void> {
    const ceiling = this.input.lane.ceilingOf;
    if (!ceiling) return;
    if ([...this.input.memo.decided.keys()].some((step) => step.endsWith('/ceiling'))) return;
    const spent = this.record.unit.costUsd + this.input.memo.costUsd + this.spentUsd;
    if (spent < ceiling.maxUsd) return;
    throw new Blocked({ kind: 'blocked', step: `${addr}/ceiling`, on: 'decision', halt: ceiling.onExceed, ask: `unit "${this.record.unit.key}" has spent $${spent.toFixed(2)} of its $${ceiling.maxUsd.toFixed(2)} ceiling before "${addr}"`, facets: [] });
  }

  private async seat(seat: AnySeat, input: unknown, options: StepOptions, addr: string, iteration: number): Promise<unknown> {
    const role = seat.roleDef!;
    const key = `${this.input.attemptId}/${addr}`;
    const model = await this.runtime.chooseModel(seat, this.kindRef(), this.input.attemptId);
    const driver = this.runtime.driverFor(model);
    const recorded = this.input.memo.invocations.get(addr);
    const startedAt = this.runtime.now();
    let response: ModelResponse | undefined;
    let account: Account | undefined;
    let number = recorded?.number ?? 0;
    const decided = this.input.memo.decided.get(addr);
    const interrupted = this.interrupted(addr);
    if (interrupted) {
      await this.recordInterruption(addr);
      const status = driver.session ? await driver.session(key, this.runtime.resolver) : { status: 'lost' as const };
      if (status.status === 'finished' && !(decided && status.response.halt?.halt === decided.halt)) {
        response = status.response;
        account = recorded?.account ? this.runtime.accountNamed(seat, recorded.account) : this.runtime.soleAccount(seat, model);
        number += 1;
      } else if (status.status === 'running') {
        throw new Blocked({ kind: 'blocked', step: addr, on: 'job', detail: `session "${key}" is still running in the driver`, resumeAt: new Date(this.runtime.now().getTime() + SESSION_POLL_MS) });
      }
    }
    await this.visit(addr, iteration);
    const recalled = await this.recallFor(role, options);
    if (!response) {
      await this.ceiling(addr);
      const resume = this.input.resume?.step === addr && this.input.resume.decision !== undefined && decided ? { ...(recorded?.sessionId ? { sessionId: recorded.sessionId } : {}), halt: decided.halt, decision: this.input.resume.decision } : undefined;
      const workspacePath = options.workspace ? await this.workspacePath() : undefined;
      const guard = options.guard && workspacePath ? this.guardFor(seat, driver, options, workspacePath, key, addr) : undefined;
      let call;
      try {
        call = await this.withAccount(seat, model, addr, false, number, (candidate) =>
          driver.invoke(this.request(seat, model, candidate, input, recalled.items, options, key, { ...(resume ? { resume } : {}), ...(workspacePath ? { workspacePath } : {}), ...(guard ? { guard } : {}) }), this.runtime.resolver),
        );
      } finally {
        if (guard) this.runtime.unregisterGuard(key);
      }
      response = call.result;
      account = call.account;
      number = call.number;
    }
    if (account) await this.runtime.quotaEvents(account, this.usageOf(response));
    this.spentUsd += response.costUsd ?? 0;
    await this.append([this.invocationEvent(seat, model, account, addr, number, false, response, startedAt, recalled.items.map((item) => item.id))]);
    await this.runtime.recordFromRole(role.name, response.recorded ?? []);
    if (response.halt) {
      const halt = (options.halts ?? []).find((candidate) => candidate.name === response!.halt!.halt);
      throw new Blocked({ kind: 'blocked', step: addr, on: 'decision', ...(halt ? { halt } : {}), ask: response.halt.ask });
    }
    const parsed = role.outputSchema ? role.outputSchema.safeParse(response.output) : { success: true as const, data: response.output };
    if (!parsed.success) throw new StepFailed({ kind: 'failed', step: addr, error: `seat "${seat.name}" returned output that fails its role's schema` });
    await this.finish(addr, iteration, true, parsed.data as Json, startedAt);
    return parsed.data;
  }

  private async job(job: JobDef<unknown, unknown>, input: unknown, addr: string, iteration: number): Promise<unknown> {
    const submitted = this.input.memo.jobs.get(addr);
    if (submitted && !submitted.collected) {
      const poll = await this.pollJob(job, submitted.jobId, addr);
      if (poll.state === 'running') throw new Blocked({ kind: 'blocked', step: addr, on: 'job', resumeAt: new Date(this.runtime.now().getTime() + job.pollEveryMinutes * 60_000) });
      const collected: LedgerEvent = { type: 'jobCollected', attemptId: this.input.attemptId, step: addr, job: job.name, jobId: submitted.jobId, state: poll.state, at: this.runtime.now() };
      if (poll.state === 'failed') {
        await this.append([collected]);
        throw new StepFailed({ kind: 'failed', step: addr, error: `job "${job.name}" failed: ${poll.reason}` });
      }
      await this.finish(addr, iteration, true, poll.result as Json, this.runtime.now(), [collected]);
      return poll.result;
    }
    if (submitted?.collected) throw new StepFailed({ kind: 'failed', step: addr, error: `job "${job.name}" was collected but its result was not recorded; restart the attempt` });
    await this.visit(addr, iteration);
    const submittedEvent = (handle: JobHandle, requests: number): LedgerEvent => ({ type: 'jobSubmitted', attemptId: this.input.attemptId, step: addr, job: job.name, jobId: handle.jobId, requests, at: this.runtime.now() });
    const earlier = this.input.memo.outputs.get(`${addr}/submit`);
    if (earlier !== undefined) {
      await this.append([submittedEvent(earlier as unknown as JobHandle, 1)]);
    } else if (job.batchOf) {
      await this.submitBatch(job, input as readonly unknown[], addr, submittedEvent);
    } else if (job.submit?.entity === 'command') {
      await this.command(job.submit as CommandDef<unknown, unknown>, input, `${addr}/submit`, this.iteration, (output) => [submittedEvent(output as unknown as JobHandle, 1)]);
    } else {
      throw new StepFailed({ kind: 'failed', step: addr, error: `job "${job.name}" has no submit command the engine can run` });
    }
    throw new Blocked({ kind: 'blocked', step: addr, on: 'job', resumeAt: new Date(this.runtime.now().getTime() + job.pollEveryMinutes * 60_000) });
  }

  private batchDriver(seat: AnySeat, model: Model, addr: string): ModelDriver {
    const driver = this.runtime.driverFor(model);
    if (!driver.submitBatch || !driver.collectBatch) throw new StepFailed({ kind: 'failed', step: addr, error: `driver "${driver.name}" cannot run batches for seat "${seat.name}"` });
    return driver;
  }

  private async submitBatch(job: JobDef<unknown, unknown>, items: readonly unknown[], addr: string, submittedEvent: (handle: JobHandle, requests: number) => LedgerEvent): Promise<void> {
    const seat = job.batchOf!;
    const model = await this.runtime.chooseModel(seat, this.kindRef(), this.input.attemptId);
    const driver = this.batchDriver(seat, model, addr);
    const recalled = await this.recallFor(seat.roleDef!, {});
    await this.ceiling(addr);
    const key = `${this.input.attemptId}/${addr}`;
    const startedAt = this.runtime.now();
    const call = await this.withAccount(seat, model, addr, true, this.input.memo.invocations.get(addr)?.number ?? 0, (account) =>
      driver.submitBatch!(items.map((item, index) => this.request(seat, model, account, item, recalled.items, {}, `${key}#${index}`)), this.runtime.resolver),
    );
    const submission: ModelResponse = { output: null, costUsd: 0, tokens: 0 };
    await this.append([
      this.invocationEvent(seat, model, call.account, addr, call.number, true, submission, startedAt, recalled.items.map((item) => item.id)),
      submittedEvent(call.result, items.length),
    ]);
  }

  private async pollJob(job: JobDef<unknown, unknown>, jobId: string, addr: string): Promise<JobPoll<unknown>> {
    if (job.batchOf) {
      const seat = job.batchOf;
      const role = seat.roleDef!;
      const submitted = this.input.memo.invocations.get(addr);
      const model = submitted?.model ? modelsOf(seat).find((candidate) => candidate.name === submitted.model) : undefined;
      if (!submitted || !model) return { state: 'failed', reason: `batch "${job.name}" has no recorded submission at "${addr}"` };
      const driver = this.batchDriver(seat, model, addr);
      let responses: readonly ModelResponse[] | undefined;
      try {
        responses = await driver.collectBatch!(jobId, this.runtime.resolver);
      } catch (err) {
        return { state: 'failed', reason: message(err) };
      }
      if (!responses) return { state: 'running' };
      const account = submitted.account ? this.runtime.accountNamed(seat, submitted.account) : undefined;
      const at = this.runtime.now();
      const tokens = responses.reduce((sum, response) => sum + response.tokens, 0);
      const costUsd = responses.reduce((sum, response) => sum + (response.costUsd ?? 0), 0);
      const equivalentUsd = responses.reduce((sum, response) => sum + (response.equivalentUsd ?? response.costUsd ?? 0), 0);
      if (account) {
        await this.runtime.quotaEvents(account, [
          { type: 'consumed', tokens, costUsd, at },
          ...responses.flatMap((response) => (response.windows ?? []).map((window) => ({ type: 'windowObserved' as const, window: window.window, ...(window.kind ? { kind: window.kind } : {}), utilization: window.utilization, resetsAt: window.resetsAt, at }))),
        ]);
      }
      this.spentUsd += costUsd;
      await this.append([this.invocationEvent(seat, model, account, addr, submitted.number + 1, true, { output: null, costUsd, equivalentUsd, tokens }, at, [])]);
      const outputs: unknown[] = [];
      for (const [index, response] of responses.entries()) {
        const parsed = role.outputSchema ? role.outputSchema.safeParse(response.output) : { success: true as const, data: response.output };
        if (!parsed.success) return { state: 'failed', reason: `batch "${job.name}" item ${index} returned output that fails the role's schema` };
        outputs.push(parsed.data);
      }
      return { state: 'succeeded', result: outputs };
    }
    if (job.collect?.entity === 'command') {
      const command = job.collect as CommandDef<JobHandle, JobPoll<unknown>>;
      const runner = command.runnerChoice;
      if (!runner || runner.entity !== 'runner') throw new StepFailed({ kind: 'failed', step: addr, error: `job "${job.name}" collect command has no runner` });
      return this.guarded(addr, `the collect of job "${job.name}"`, async () => {
        const result = await this.exec(runner, command.argvOf ? command.argvOf({ jobId }) : []);
        if (!command.acceptedExitCodes.includes(result.exitCode)) return { state: 'failed' as const, reason: result.stderr };
        return command.outputSchema ? command.outputSchema.parse(JSON.parse(result.stdout)) : (JSON.parse(result.stdout) as JobPoll<unknown>);
      });
    }
    throw new StepFailed({ kind: 'failed', step: addr, error: `job "${job.name}" has no collect command the engine can run` });
  }

  private async halt(node: Extract<FlowNode, { type: 'halt' }>, addr: string, iteration: number): Promise<unknown> {
    const options = node.options as HaltOptions<unknown, unknown, Record<string, unknown>, unknown>;
    const decided = this.input.memo.decisions.get(addr);
    if (decided !== undefined) return decided;
    if (this.input.memo.notAsked.has(addr)) return undefined;
    if (node.when && !(await this.guarded(addr, `the condition of halt "${node.name}"`, () => node.when!(this.ctx())))) {
      await this.append([{ type: 'haltNotAsked', attemptId: this.input.attemptId, step: addr, halt: node.halt.name, at: this.runtime.now() }]);
      return undefined;
    }
    if (this.input.resume?.step === addr && this.input.resume.decision !== undefined) return this.input.resume.decision;
    const facetValues = options.facets ? await this.guarded(addr, `the facets of halt "${node.name}"`, () => options.facets!(this.ctx())) : [];
    const facets = facetValues.map((facet) => ({ facet: facet.facet.name, value: facet.value }));
    if (options.skip) {
      const recording = recordingMetrics(this.input.metrics);
      const decision = await this.guarded(addr, `policy "${options.skip.name}"`, () => options.skip!.decide({ unit: this.unitView(), facets: facetValues, metrics: recording.metrics }));
      if (decision !== undefined) {
        await this.append([{ type: 'decisionRecorded', attemptId: this.input.attemptId, step: addr, halt: node.halt.name, decision: decision as Json, resolvedBy: 'policy', by: options.skip.name, facets, reads: recording.reads, at: this.runtime.now() }]);
        return decision;
      }
    }
    await this.visit(addr, iteration);
    const ask = await this.guarded(addr, `the ask of halt "${node.name}"`, () => options.ask(this.ctx()));
    const clocks = { ...(options.escalate ? { escalateMinutes: options.escalate.afterMinutes } : {}), ...(options.timeout ? { timeoutMinutes: options.timeout.afterMinutes } : {}) };
    throw new Blocked({ kind: 'blocked', step: addr, on: 'decision', halt: node.halt, ask, facets, ...(Object.keys(clocks).length > 0 ? { clocks } : {}) });
  }

  private async spawn(node: Extract<FlowNode, { type: 'spawn' }>, addr: string, iteration: number): Promise<readonly ChildResult[]> {
    const children = await this.runtime.childrenOf(this.input.record.unit.id, node.lane);
    const startedAt = this.runtime.now();
    if (children.length === 0 && !this.input.memo.visited.has(addr)) {
      await this.visit(addr, iteration);
      const attrs = await this.guarded(addr, `the children of spawn "${node.name}"`, () => node.children(this.ctx()));
      if (attrs.length === 0) {
        await this.finish(addr, iteration, true, [], startedAt);
        return [];
      }
      await this.guarded(addr, `the children of spawn "${node.name}"`, () => this.runtime.createUnits(node.lane, attrs, { parentId: this.input.record.unit.id, source: `spawn:${addr}` }));
      throw new Blocked({ kind: 'blocked', step: addr, on: 'children' });
    }
    if (children.length === 0) {
      await this.finish(addr, iteration, true, [], startedAt);
      return [];
    }
    const results = children.map((child): ChildResult => ({ unitId: child.unit.id, state: { entity: 'state', name: child.unit.state, position: child.unit.statePosition, ...(child.unit.verdict ? { verdict: child.unit.verdict } : {}) }, ...(child.unit.verdict ? { verdict: child.unit.verdict } : {}) }));
    if (children.some((child) => child.unit.position !== 'terminal')) throw new Blocked({ kind: 'blocked', step: addr, on: 'children' });
    await this.finish(addr, iteration, true, results as unknown as Json, startedAt);
    return results;
  }
}

/** The workspace a flow's steps declare, if any: the attempt's working directory. */
export function workspaceOf(flow: FlowDef<unknown, unknown, unknown, string, string>): WorkspaceDef | undefined {
  const find = (nodes: readonly FlowNode[]): WorkspaceDef | undefined => {
    for (const node of nodes) {
      if (node.type === 'step' && node.options.workspace) return node.options.workspace;
      if (node.type === 'when' || node.type === 'loop') {
        const inner = find(node.nodes);
        if (inner) return inner;
      }
    }
    return undefined;
  };
  return find(flow.nodes);
}
