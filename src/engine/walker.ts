import { z } from 'zod';
import type { CommandDef, CommandResult } from '../dsl/commands.js';
import type { Executable } from '../dsl/executables.js';
import type { FlowCtx, FlowDef, FlowNode, HaltOptions, StepOptions } from '../dsl/flows.js';
import type { HaltDef } from '../dsl/halts.js';
import type { JobDef, JobHandle, JobPoll } from '../dsl/jobs.js';
import type { RoleDef } from '../dsl/roles.js';
import type { LaneDef } from '../dsl/lanes.js';
import type { RunnerPolicyDef } from '../dsl/policies.js';
import type { RunnerDef } from '../dsl/runners.js';
import type { ChildResult, UnitView } from '../dsl/views.js';
import type { Account, KindRef, LedgerEvent, MemoryItem, Metrics, Model, ModelDriver, ModelRequest, ModelResponse, State, StoredFacetValue, UnitRecord } from '../kernel/index.js';
import { AccountRefusedError } from '../kernel/quota.js';
import type { Json, JsonObject } from '../kernel/refs.js';
import { address, type Frame } from './address.js';
import type { Memo } from './memo.js';
import type { Recalled } from './recall.js';
import type { QuotaEventBody, Runtime } from './runtime.js';
import { modelsOf, type AnySeat } from './seats.js';

export type WalkOutcome =
  | { readonly kind: 'exit'; readonly exit: string }
  | { readonly kind: 'blocked'; readonly step: string; readonly on: 'decision' | 'timer' | 'children' | 'job' | 'interrupted' | 'budget'; readonly halt?: HaltDef<string, unknown>; readonly ask?: string; readonly facets?: readonly StoredFacetValue[]; readonly detail?: string; readonly resumeAt?: Date; readonly clocks?: { readonly escalateMinutes?: number; readonly timeoutMinutes?: number } }
  | { readonly kind: 'failed'; readonly step: string; readonly error: string };

class Blocked {
  public constructor(public readonly outcome: Extract<WalkOutcome, { kind: 'blocked' }>) {}
}

class StepFailed {
  public constructor(public readonly outcome: Extract<WalkOutcome, { kind: 'failed' }>) {}
}

class Exited {
  public constructor(public readonly outcome: Extract<WalkOutcome, { kind: 'exit' }>) {}
}

type AnyCtx = FlowCtx<unknown, unknown, Record<string, unknown>>;

export interface WalkInput {
  readonly runtime: Runtime;
  readonly lane: LaneDef<unknown, State, unknown, string>;
  readonly flow: FlowDef<unknown, unknown, unknown, string, string>;
  readonly record: UnitRecord;
  readonly attemptId: string;
  readonly memo: Memo;
  readonly metrics: Metrics;
  readonly resume?: { readonly step: string; readonly decision?: Json };
}

export async function walk(input: WalkInput): Promise<WalkOutcome> {
  const walker = new Walker(input);
  try {
    await walker.run(input.flow.nodes, []);
    return { kind: 'failed', step: '', error: `flow "${input.flow.name}" reached no exit` };
  } catch (err) {
    if (err instanceof Exited) return err.outcome;
    if (err instanceof Blocked) return err.outcome;
    if (err instanceof StepFailed) return err.outcome;
    throw err;
  }
}

class Walker {
  private readonly steps: Record<string, unknown> = {};
  private readonly carries: Record<string, unknown> = {};
  private iteration = 0;
  private now: Date;

  public constructor(private readonly input: WalkInput) {
    this.now = input.memo.lastAt;
  }

  private get runtime(): Runtime {
    return this.input.runtime;
  }

  private unitView(): UnitView<unknown> {
    return this.runtime.unitView(this.input.record);
  }

  private ctx(): AnyCtx {
    return { unit: this.unitView(), params: this.input.lane.handlerDef?.params, steps: { ...this.carries, ...this.steps }, now: this.now, iteration: this.iteration };
  }

  private async append(events: readonly LedgerEvent[]): Promise<void> {
    await this.runtime.append(events);
  }

  private async visit(addr: string, atIteration: number): Promise<void> {
    const recorded = this.input.memo.invocations.get(addr);
    if (recorded?.started) return;
    const at = this.runtime.now();
    this.now = at;
    await this.append([{ type: 'stepStarted', attemptId: this.input.attemptId, step: addr, iteration: atIteration, at }]);
  }

  private async finish(addr: string, atIteration: number, ok: boolean, output: Json | undefined, startedAt: Date): Promise<void> {
    const at = this.runtime.now();
    await this.append([{ type: 'stepEnded', attemptId: this.input.attemptId, step: addr, iteration: atIteration, ok, output, durationMs: Math.max(0, at.getTime() - startedAt.getTime()), at }]);
  }

  public async run(nodes: readonly FlowNode[], frames: readonly Frame[]): Promise<void> {
    for (const node of nodes) {
      await this.node(node, frames);
    }
  }

  private async node(node: FlowNode, frames: readonly Frame[]): Promise<void> {
    const here = [...frames, { name: node.name }];
    const addr = address(here);
    const iteration = this.iteration;
    switch (node.type) {
      case 'step': {
        const memo = this.input.memo.outputs.get(addr);
        if (memo !== undefined) {
          this.steps[node.name] = memo;
          return;
        }
        this.steps[node.name] = await this.step(node, addr, iteration);
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
        const query = node.query ? node.query(this.ctx()) : {};
        const value = node.metric.measure === 'rate' ? this.input.metrics.rate(node.metric as never, query) : this.input.metrics.total(node.metric as never, query);
        const read = { metric: node.metric.name, dimensions: {}, value: 'rate' in value ? value.rate : value.total, samples: value.samples };
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
        const resumeAt = new Date(startedAt.getTime() + node.ms);
        if (this.input.resume?.step === addr) {
          await this.finish(addr, iteration, true, this.runtime.now().toISOString(), startedAt);
          this.steps[node.name] = this.runtime.now();
          return;
        }
        await this.visit(addr, iteration);
        throw new Blocked({ kind: 'blocked', step: addr, on: 'timer', resumeAt });
      }
      case 'when': {
        if (node.predicate(this.ctx())) await this.run(node.nodes, here);
        return;
      }
      case 'parallel': {
        const memo = this.input.memo.outputs.get(addr);
        if (memo !== undefined) {
          this.steps[node.name] = memo;
          return;
        }
        const startedAt = this.runtime.now();
        await this.visit(addr, iteration);
        const entries = await Promise.all(
          Object.entries(node.branches).map(async ([key, branch]) => {
            const branchAddr = address([...here, { name: key }]);
            const stepNode: Extract<FlowNode, { type: 'step' }> =
              'exec' in branch
                ? { type: 'step', name: key, exec: branch.exec, input: branch.input as (ctx: AnyCtx) => unknown, options: {} }
                : { type: 'step', name: key, exec: branch as Executable<unknown, unknown>, options: {} };
            const recorded = this.input.memo.outputs.get(branchAddr);
            return [key, recorded !== undefined ? recorded : await this.step(stepNode, branchAddr, iteration)] as const;
          }),
        );
        const output = Object.fromEntries(entries) as JsonObject;
        await this.finish(addr, iteration, true, output, startedAt);
        this.steps[node.name] = output;
        return;
      }
      case 'loop': {
        await this.loop(node, here);
        return;
      }
      case 'exit': {
        if (node.when === undefined || node.when(this.ctx())) throw new Exited({ kind: 'exit', exit: node.name });
        return;
      }
    }
  }

  private async loop(node: Extract<FlowNode, { type: 'loop' }>, here: readonly Frame[]): Promise<void> {
    const span = node.bounds.span ?? 'attempt';
    const recorded = this.input.memo.loops.get(node.name);
    let iteration = recorded?.iteration ?? 0;
    let carry: unknown = recorded?.carry ?? node.carry?.initial;
    const outer = this.iteration;
    while (true) {
      const max = typeof node.bounds.max === 'function' ? node.bounds.max(this.ctx()) : node.bounds.max;
      if (max !== undefined && iteration >= max) break;
      if (recorded === undefined || recorded.iteration !== iteration || iteration > (recorded?.iteration ?? -1)) {
        await this.append([{ type: 'loopIteration', unitId: this.input.record.unit.id, attemptId: this.input.attemptId, loop: node.name, iteration, span, ...(node.carry ? { carry: carry as Json } : {}), at: this.runtime.now() }]);
      }
      if (node.carry) this.carries[node.name] = carry;
      this.iteration = iteration;
      const frames = [...here.slice(0, -1), { name: node.name, iteration }];
      await this.run(node.nodes, frames);
      if (node.bounds.until?.(this.ctx())) break;
      iteration += 1;
      if (node.carry) carry = node.carry.next(this.ctx());
    }
    this.iteration = outer;
  }

  private async step(node: Extract<FlowNode, { type: 'step' }>, addr: string, iteration: number): Promise<unknown> {
    const exec = node.exec;
    const input = node.input ? node.input(this.ctx()) : undefined;
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

  private async command(command: CommandDef<unknown, unknown>, input: unknown, addr: string, iteration: number): Promise<unknown> {
    const recorded = this.input.memo.invocations.get(addr);
    if (recorded?.started && !recorded.ended && this.input.resume?.step === addr) {
      const output: CommandResult = { exitCode: 0, stdout: '', stderr: '' };
      await this.finish(addr, iteration, true, output as unknown as Json, this.runtime.now());
      return output;
    }
    if (recorded?.started && !recorded.ended) {
      await this.append([{ type: 'attemptInterrupted', attemptId: this.input.attemptId, step: addr, holder: this.runtime.holder, at: this.runtime.now() }]);
      if (command.effectKind === 'unrepeatable') {
        throw new Blocked({ kind: 'blocked', step: addr, on: 'interrupted', detail: `command "${command.name}" is unrepeatable and was running when the harness stopped` });
      }
      if (command.effectKind === 'external' && command.detect) {
        const runner = await this.pickRunner(command, addr);
        const happened = await command.detect({ input, exec: (argv) => this.exec(runner, argv) });
        if (happened) {
          const output: CommandResult = { exitCode: 0, stdout: '', stderr: '' };
          await this.finish(addr, iteration, true, output as unknown as Json, this.runtime.now());
          return output;
        }
      }
    }
    const startedAt = this.runtime.now();
    await this.visit(addr, iteration);
    const runner = await this.pickRunner(command, addr);
    const argv = command.argvOf ? command.argvOf(input) : [];
    const result = await this.exec(runner, argv);
    const ok = command.acceptedExitCodes.includes(result.exitCode);
    await this.append([{ type: 'invocation', attemptId: this.input.attemptId, step: addr, number: 1, executable: command.name, runner: runner.name, viaJob: false, ok, costUsd: 0, durationMs: result.durationMs, at: this.runtime.now() }]);
    if (!ok) {
      await this.finish(addr, iteration, false, undefined, startedAt);
      throw new StepFailed({ kind: 'failed', step: addr, error: `command "${command.name}" exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}` });
    }
    let output: unknown = { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    if (command.outputSchema) {
      try {
        output = command.outputSchema.parse(JSON.parse(result.stdout));
      } catch (err) {
        await this.finish(addr, iteration, false, undefined, startedAt);
        throw new StepFailed({ kind: 'failed', step: addr, error: `command "${command.name}" produced output that fails its schema: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    await this.finish(addr, iteration, true, output as Json, startedAt);
    return output;
  }

  private async pickRunner(command: CommandDef<unknown, unknown>, addr: string): Promise<RunnerDef> {
    const choice = command.runnerChoice;
    if (!choice) throw new StepFailed({ kind: 'failed', step: addr, error: `command "${command.name}" has no runner` });
    if (choice.entity === 'runner') return choice;
    const policy = choice as RunnerPolicyDef;
    const runner = policy.decide({ candidates: policy.candidates, unit: this.unitView(), metrics: this.input.metrics });
    await this.append([{ type: 'policyDecision', attemptId: this.input.attemptId, policy: policy.name, value: runner.name, at: this.runtime.now() }]);
    return runner;
  }

  private async exec(runner: RunnerDef, argv: readonly string[]): Promise<CommandResult & { readonly durationMs: number }> {
    return runner.backend.exec({ argv, env: {} }, new AbortController().signal, this.runtime.resolver);
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

  private request(seat: AnySeat, model: Model, account: Account, input: unknown, memory: readonly MemoryItem[], options: StepOptions, key: string, extra: Pick<ModelRequest, 'resume' | 'workspacePath'> = {}): ModelRequest {
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

  /**
   * Runs one call on an account of the seat's pool. An account that refuses the call gets its
   * cooldown and windows on the partition, a failed invocation on the ledger, and the next account
   * tries; no account at all blocks the step on budget.
   */
  private async withAccount<T>(seat: AnySeat, model: Model, addr: string, viaJob: boolean, call: (account: Account) => Promise<T>): Promise<{ readonly account: Account; readonly number: number; readonly result: T }> {
    const excluded = new Set<string>();
    let number = 0;
    for (;;) {
      const acquired = await this.runtime.acquireAccount(seat, model, excluded, this.input.attemptId);
      if (!acquired.account) throw new Blocked({ kind: 'blocked', step: addr, on: 'budget', detail: acquired.detail, ...(acquired.resumeAt ? { resumeAt: acquired.resumeAt } : {}) });
      const account = acquired.account;
      number += 1;
      const startedAt = this.runtime.now();
      try {
        return { account, number, result: await call(account) };
      } catch (err) {
        const at = this.runtime.now();
        if (!(err instanceof AccountRefusedError)) {
          await this.append([{ type: 'invocation', attemptId: this.input.attemptId, step: addr, number, executable: seat.name, seat: seat.name, model: model.name, account: account.name, viaJob, ok: false, costUsd: 0, durationMs: Math.max(0, at.getTime() - startedAt.getTime()), at }]);
          throw new StepFailed({ kind: 'failed', step: addr, error: `seat "${seat.name}" failed: ${err instanceof Error ? err.message : String(err)}` });
        }
        await this.runtime.quotaEvents(account, [
          { type: 'cooldown', until: err.until, reason: `${err.refusal}: ${err.message}`, at },
          ...err.windows.map((window) => ({ type: 'windowObserved' as const, window: window.window, ...(window.kind ? { kind: window.kind } : {}), utilization: window.utilization, resetsAt: window.resetsAt, at })),
        ]);
        await this.append([{ type: 'invocation', attemptId: this.input.attemptId, step: addr, number, executable: seat.name, seat: seat.name, model: model.name, account: account.name, viaJob, ok: false, costUsd: 0, durationMs: Math.max(0, at.getTime() - startedAt.getTime()), at }]);
        excluded.add(account.name);
      }
    }
  }

  private async seat(seat: AnySeat, input: unknown, options: StepOptions, addr: string, iteration: number): Promise<unknown> {
    const role = seat.roleDef!;
    const key = `${this.input.attemptId}/${addr}`;
    const model = await this.runtime.chooseModel(seat, this.kindRef(), this.input.attemptId);
    const driver = this.runtime.driverFor(model);
    const recorded = this.input.memo.invocations.get(addr);
    const startedAt = this.runtime.now();
    let response: ModelResponse | undefined;
    if (recorded?.started && !recorded.ended) {
      await this.append([{ type: 'attemptInterrupted', attemptId: this.input.attemptId, step: addr, holder: this.runtime.holder, at: this.runtime.now() }]);
      const status = driver.session ? await driver.session(key, this.runtime.resolver) : { status: 'lost' as const };
      if (status.status === 'finished') response = status.response;
      else if (status.status === 'running') throw new Blocked({ kind: 'blocked', step: addr, on: 'job', detail: `session "${key}" is still running in the driver` });
    }
    if (!response) {
      await this.visit(addr, iteration);
      const recalled = await this.recallFor(role, options);
      const resume = this.input.resume?.step === addr && this.input.resume.decision !== undefined && recorded?.sessionId
        ? { sessionId: recorded.sessionId, halt: this.input.memo.blocked?.halt ?? '', decision: this.input.resume.decision }
        : undefined;
      const workspacePath = options.workspace ? (await options.workspace.backend.prepare(this.input.attemptId)).path : undefined;
      const guard = options.guard && workspacePath ? this.guardFor(seat, driver, options, workspacePath, key, addr) : undefined;
      let call;
      try {
        call = await this.withAccount(seat, model, addr, false, (account) =>
          driver.invoke(this.request(seat, model, account, input, recalled.items, options, key, { ...(resume ? { resume } : {}), ...(workspacePath ? { workspacePath } : {}), ...(guard ? { guard } : {}) }), this.runtime.resolver),
        );
      } finally {
        if (guard) this.runtime.unregisterGuard(key);
      }
      response = call.result;
      await this.runtime.quotaEvents(call.account, this.usageOf(response));
      await this.append([
        {
          type: 'invocation',
          attemptId: this.input.attemptId,
          step: addr,
          number: call.number,
          executable: seat.name,
          seat: seat.name,
          model: model.name,
          account: call.account.name,
          viaJob: false,
          ok: true,
          costUsd: response.costUsd ?? 0,
          tokens: response.tokens,
          ...(response.sessionId ? { sessionId: response.sessionId } : {}),
          ...(recalled.items.length > 0 ? { memory: recalled.items.map((item) => item.id) } : {}),
          durationMs: Math.max(0, this.runtime.now().getTime() - startedAt.getTime()),
          at: this.runtime.now(),
        },
      ]);
      await this.runtime.recordFromRole(role.name, seat.name, response.recorded ?? []);
    }
    if (response.halt) {
      const halt = (options.halts ?? []).find((candidate) => candidate.name === response!.halt!.halt);
      throw new Blocked({ kind: 'blocked', step: addr, on: 'decision', ...(halt ? { halt } : {}), ask: response.halt.ask });
    }
    const parsed = role.outputSchema ? role.outputSchema.safeParse(response.output) : { success: true as const, data: response.output };
    if (!parsed.success) {
      await this.finish(addr, iteration, false, undefined, startedAt);
      throw new StepFailed({ kind: 'failed', step: addr, error: `seat "${seat.name}" returned output that fails its role's schema` });
    }
    await this.finish(addr, iteration, true, parsed.data as Json, startedAt);
    return parsed.data;
  }

  private async job(job: JobDef<unknown, unknown>, input: unknown, addr: string, iteration: number): Promise<unknown> {
    const submitted = this.input.memo.jobs.get(addr);
    if (submitted && !submitted.collected) {
      const poll = await this.pollJob(job, submitted.jobId, addr);
      if (poll.state === 'running') throw new Blocked({ kind: 'blocked', step: addr, on: 'job', resumeAt: new Date(this.runtime.now().getTime() + job.pollEveryMinutes * 60_000) });
      await this.append([{ type: 'jobCollected', attemptId: this.input.attemptId, step: addr, job: job.name, jobId: submitted.jobId, state: poll.state, at: this.runtime.now() }]);
      if (poll.state === 'failed') {
        await this.finish(addr, iteration, false, undefined, this.runtime.now());
        throw new StepFailed({ kind: 'failed', step: addr, error: `job "${job.name}" failed: ${poll.reason}` });
      }
      await this.finish(addr, iteration, true, poll.result as Json, this.runtime.now());
      return poll.result;
    }
    await this.visit(addr, iteration);
    const { handle, requests } = await this.submitJob(job, input, addr);
    await this.append([{ type: 'jobSubmitted', attemptId: this.input.attemptId, step: addr, job: job.name, jobId: handle.jobId, requests, at: this.runtime.now() }]);
    throw new Blocked({ kind: 'blocked', step: addr, on: 'job', resumeAt: new Date(this.runtime.now().getTime() + job.pollEveryMinutes * 60_000) });
  }

  private batchDriver(seat: AnySeat, model: Model, addr: string): ModelDriver {
    const driver = this.runtime.driverFor(model);
    if (!driver.submitBatch || !driver.collectBatch) throw new StepFailed({ kind: 'failed', step: addr, error: `driver "${driver.name}" cannot run batches for seat "${seat.name}"` });
    return driver;
  }

  private async submitJob(job: JobDef<unknown, unknown>, input: unknown, addr: string): Promise<{ readonly handle: JobHandle; readonly requests: number }> {
    if (job.batchOf) {
      const seat = job.batchOf;
      const items = input as readonly unknown[];
      const model = await this.runtime.chooseModel(seat, this.kindRef(), this.input.attemptId);
      const driver = this.batchDriver(seat, model, addr);
      const recalled = await this.recallFor(seat.roleDef!, {});
      const key = `${this.input.attemptId}/${addr}`;
      const startedAt = this.runtime.now();
      const call = await this.withAccount(seat, model, addr, true, (account) =>
        driver.submitBatch!(items.map((item, index) => this.request(seat, model, account, item, recalled.items, {}, `${key}#${index}`)), this.runtime.resolver),
      );
      await this.append([
        {
          type: 'invocation',
          attemptId: this.input.attemptId,
          step: addr,
          number: call.number,
          executable: job.name,
          seat: seat.name,
          model: model.name,
          account: call.account.name,
          viaJob: true,
          ok: true,
          costUsd: 0,
          tokens: 0,
          ...(recalled.items.length > 0 ? { memory: recalled.items.map((item) => item.id) } : {}),
          durationMs: Math.max(0, this.runtime.now().getTime() - startedAt.getTime()),
          at: this.runtime.now(),
        },
      ]);
      return { handle: call.result, requests: items.length };
    }
    if (job.submit?.entity === 'command') {
      const result = (await this.command(job.submit as CommandDef<unknown, unknown>, input, `${addr}/submit`, this.iteration)) as JobHandle;
      return { handle: result, requests: 1 };
    }
    throw new StepFailed({ kind: 'failed', step: addr, error: `job "${job.name}" has no submit command the engine can run` });
  }

  private async submittedBatch(addr: string): Promise<Extract<LedgerEvent, { type: 'invocation' }> | undefined> {
    let found: Extract<LedgerEvent, { type: 'invocation' }> | undefined;
    for await (const { event } of this.runtime.ledger.read({ attemptId: this.input.attemptId, types: ['invocation'] })) {
      if (event.type === 'invocation' && event.step === addr && event.viaJob && event.ok) found = event;
    }
    return found;
  }

  private async pollJob(job: JobDef<unknown, unknown>, jobId: string, addr: string): Promise<JobPoll<unknown>> {
    if (job.batchOf) {
      const seat = job.batchOf;
      const role = seat.roleDef!;
      const submitted = await this.submittedBatch(addr);
      const model = submitted?.model ? modelsOf(seat).find((candidate) => candidate.name === submitted.model) : undefined;
      if (!submitted || !model) return { state: 'failed', reason: `batch "${job.name}" has no recorded submission at "${addr}"` };
      const driver = this.batchDriver(seat, model, addr);
      let responses: readonly ModelResponse[] | undefined;
      try {
        responses = await driver.collectBatch!(jobId, this.runtime.resolver);
      } catch (err) {
        return { state: 'failed', reason: err instanceof Error ? err.message : String(err) };
      }
      if (!responses) return { state: 'running' };
      const account = submitted.account ? this.runtime.accountNamed(seat, submitted.account) : undefined;
      const at = this.runtime.now();
      const tokens = responses.reduce((sum, response) => sum + response.tokens, 0);
      const costUsd = responses.reduce((sum, response) => sum + (response.costUsd ?? 0), 0);
      if (account) {
        await this.runtime.quotaEvents(account, [
          { type: 'consumed', tokens, costUsd, at },
          ...responses.flatMap((response) => (response.windows ?? []).map((window) => ({ type: 'windowObserved' as const, window: window.window, ...(window.kind ? { kind: window.kind } : {}), utilization: window.utilization, resetsAt: window.resetsAt, at }))),
        ]);
      }
      await this.append([{ type: 'invocation', attemptId: this.input.attemptId, step: addr, number: submitted.number + 1, executable: job.name, seat: seat.name, model: model.name, ...(submitted.account ? { account: submitted.account } : {}), viaJob: true, ok: true, costUsd, tokens, durationMs: 0, at }]);
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
      if (!runner || runner.entity !== 'runner') throw new Error(`job "${job.name}" collect command has no runner`);
      const result = await this.exec(runner, command.argvOf ? command.argvOf({ jobId }) : []);
      if (!command.acceptedExitCodes.includes(result.exitCode)) return { state: 'failed', reason: result.stderr };
      return command.outputSchema ? command.outputSchema.parse(JSON.parse(result.stdout)) : (JSON.parse(result.stdout) as JobPoll<unknown>);
    }
    throw new Error(`job "${job.name}" has no collect command the engine can run`);
  }

  private async halt(node: Extract<FlowNode, { type: 'halt' }>, addr: string, iteration: number): Promise<unknown> {
    const options = node.options as HaltOptions<unknown, unknown, Record<string, unknown>, unknown>;
    const decided = this.input.memo.decisions.get(addr);
    if (decided !== undefined) return decided;
    if (node.when && !node.when(this.ctx())) {
      await this.append([{ type: 'haltNotAsked', attemptId: this.input.attemptId, step: addr, halt: node.halt.name, at: this.runtime.now() }]);
      return undefined;
    }
    if (this.input.resume?.step === addr && this.input.resume.decision !== undefined) return this.input.resume.decision;
    const facets = options.facets ? options.facets(this.ctx()).map((facet) => ({ facet: facet.facet.name, value: facet.value })) : [];
    if (options.skip) {
      const decision = options.skip.decide({ unit: this.unitView(), facets: options.facets ? options.facets(this.ctx()) : [], metrics: this.input.metrics });
      if (decision !== undefined) {
        await this.append([{ type: 'decisionRecorded', attemptId: this.input.attemptId, step: addr, halt: node.halt.name, decision: decision as Json, resolvedBy: 'policy', by: options.skip.name, facets, at: this.runtime.now() }]);
        return decision;
      }
    }
    await this.visit(addr, iteration);
    const clocks = { ...(options.escalate ? { escalateMinutes: options.escalate.afterMinutes } : {}), ...(options.timeout ? { timeoutMinutes: options.timeout.afterMinutes } : {}) };
    throw new Blocked({ kind: 'blocked', step: addr, on: 'decision', halt: node.halt, ask: options.ask(this.ctx()), facets, ...(Object.keys(clocks).length > 0 ? { clocks } : {}) });
  }

  private async spawn(node: Extract<FlowNode, { type: 'spawn' }>, addr: string, iteration: number): Promise<readonly ChildResult[]> {
    const children = await this.runtime.childrenOf(this.input.record.unit.id, node.lane);
    if (children.length === 0 && this.input.resume?.step !== addr) {
      await this.visit(addr, iteration);
      const attrs = node.children(this.ctx());
      for (const child of attrs) await this.runtime.createUnit(node.lane, child, { parentId: this.input.record.unit.id, source: `spawn:${addr}` });
      throw new Blocked({ kind: 'blocked', step: addr, on: 'children' });
    }
    const results = children.map((child): ChildResult => ({ unitId: child.unit.id, state: { entity: 'state', name: child.unit.state, position: child.unit.statePosition, ...(child.unit.verdict ? { verdict: child.unit.verdict } : {}) }, ...(child.unit.verdict ? { verdict: child.unit.verdict } : {}) }));
    if (children.some((child) => child.unit.position !== 'terminal')) throw new Blocked({ kind: 'blocked', step: addr, on: 'children' });
    await this.finish(addr, iteration, true, results as unknown as Json, this.runtime.now());
    return results;
  }
}
