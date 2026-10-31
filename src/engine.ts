import { randomUUID } from 'node:crypto';
import PQueue from 'p-queue';
import { BoundAgentSkill, ConditionalExecutable, type FlowDef, type FlowNode } from './dsl.js';
import { type HarnessStore, sumCosts } from './store.js';
import type {
  BatchItemRequest,
  Executable,
  ExecutionContext,
  FlowContext,
  HookReceiver,
  TokenUsage,
} from './types.js';

export interface FlowRunOptions {
  readonly runId?: string;
  readonly ticketId?: string;
  readonly workDir?: string;
  readonly touchedPaths?: readonly string[];
  readonly hookReceiver?: HookReceiver;
  readonly signal?: AbortSignal;
  readonly batchPollIntervalMs?: number;
}

export interface FlowRunResult<TSteps = Record<string, any>> {
  readonly runId: string;
  readonly status: 'completed';
  readonly iterations: number;
  readonly steps: TSteps;
  readonly resolutions: readonly unknown[];
  readonly workDir: string;
}

export class MaxIterationsReachedError extends Error {
  public readonly maxIterations: number;

  public constructor(flowName: string, maxIterations: number) {
    super(`Flow "${flowName}" reached maxIterations (${maxIterations}) without satisfying until()`);
    this.name = 'MaxIterationsReachedError';
    this.maxIterations = maxIterations;
  }
}

export class FlowEngine {
  public readonly store: HarnessStore;

  public constructor(store: HarnessStore) {
    this.store = store;
  }

  public async run<TInput, TSteps extends Record<string, any>>(
    flow: FlowDef<TInput, TSteps>,
    rawInput: NoInfer<TInput>,
    opts?: FlowRunOptions,
  ): Promise<FlowRunResult<TSteps>> {
    const parsedInput = flow.inputSchema.parse(rawInput);
    const runId = opts?.runId ?? `run-${randomUUID()}`;
    const signal = opts?.signal ?? new AbortController().signal;
    const baseWorkDir = opts?.workDir ?? this.store.projectDir;
    const touchedPaths = opts?.touchedPaths ?? flow.identifiers.touchedPaths?.(parsedInput) ?? [];
    const ticketId = opts?.ticketId ?? flow.identifiers.ticketId?.(parsedInput);

    this.store.createRun({
      id: runId,
      flowName: flow.name,
      ticketId,
      workDir: baseWorkDir,
      input: parsedInput,
    });

    const initialExecCtx: ExecutionContext = {
      runId,
      iteration: 0,
      stepName: 'init',
      projectDir: this.store.projectDir,
      workDir: baseWorkDir,
      touchedPaths,
      store: this.store,
      hookReceiver: opts?.hookReceiver,
      signal,
    };

    const executeCore = async (execCtx: ExecutionContext): Promise<FlowRunResult<TSteps>> => {
      const state: {
        iteration: number;
        steps: Record<string, any>;
        prev?: Record<string, any>;
        resolutions: unknown[];
        workDir: string;
      } = {
        iteration: 0,
        steps: {},
        prev: undefined,
        resolutions: [],
        workDir: execCtx.workDir,
      };

      const makeFlowCtx = (): FlowContext<TInput, any> => ({
        runId,
        iteration: state.iteration,
        input: parsedInput,
        steps: state.steps,
        prev: state.prev,
        resolutions: state.resolutions,
        workDir: state.workDir,
      });

      try {
        await this.executeNodes(flow.nodes, state, makeFlowCtx, execCtx, opts);
        this.store.updateRunProgress(runId, {
          status: 'completed',
          iteration: state.iteration,
          currentStep: null,
          state: state.steps,
          finishedAtMs: Date.now(),
        });
        return {
          runId,
          status: 'completed',
          iterations: state.iteration + 1,
          steps: state.steps as TSteps,
          resolutions: state.resolutions,
          workDir: state.workDir,
        };
      } catch (err) {
        if (flow.errorHandler) {
          await flow.errorHandler(err, makeFlowCtx() as FlowContext<TInput, TSteps>);
        }
        const currentRun = this.store.getRun(runId);
        const nextStatus =
          signal.aborted && currentRun?.status === 'cancelled' ? 'cancelled' : 'failed';
        this.store.updateRunProgress(runId, {
          status: nextStatus,
          iteration: state.iteration,
          state: state.steps,
          finishedAtMs: Date.now(),
        });
        throw err;
      } finally {
        this.store.releaseRunLeases(runId);
        if (flow.finallyHandler) {
          if (typeof flow.finallyHandler === 'function') {
            await flow.finallyHandler(makeFlowCtx() as FlowContext<TInput, TSteps>);
          } else {
            await flow.finallyHandler.execute(makeFlowCtx(), {
              ...execCtx,
              stepName: 'finally',
              workDir: state.workDir,
            });
          }
        }
      }
    };

    let chain = executeCore;
    for (let i = flow.middlewares.length - 1; i >= 0; i -= 1) {
      const mw = flow.middlewares[i]!;
      const next = chain;
      chain = (ctx: ExecutionContext) => mw.wrap(parsedInput, ctx, next);
    }

    return chain(initialExecCtx);
  }

  private async executeNodes(
    nodes: readonly FlowNode[],
    state: {
      iteration: number;
      steps: Record<string, any>;
      prev?: Record<string, any>;
      resolutions: unknown[];
      workDir: string;
    },
    makeFlowCtx: () => FlowContext<any, any>,
    baseExecCtx: ExecutionContext,
    opts?: FlowRunOptions,
  ): Promise<void> {
    for (const node of nodes) {
      if (baseExecCtx.signal.aborted) {
        throw new Error(`Flow run ${baseExecCtx.runId} aborted`);
      }

      switch (node.type) {
        case 'step': {
          await this.runSingleExecutable(
            node.name,
            node.executable,
            node.mapInput,
            state,
            makeFlowCtx,
            baseExecCtx,
            opts,
          );
          break;
        }

        case 'when': {
          const fCtx = makeFlowCtx();
          if (node.predicate(fCtx)) {
            if (node.subflow) {
              await this.executeNodes(node.subflow.nodes, state, makeFlowCtx, baseExecCtx, opts);
            } else if (node.executable) {
              const stepKey = node.stepName ?? node.executable.name;
              await this.runSingleExecutable(
                stepKey,
                node.executable,
                node.mapInput,
                state,
                makeFlowCtx,
                baseExecCtx,
                opts,
              );
            }
          }
          break;
        }

        case 'branch': {
          const fCtx = makeFlowCtx();
          const key = node.selector(fCtx);
          const target = node.branches[key];
          if (target) {
            if ('nodes' in target && target.kind === 'flow') {
              await this.executeNodes(target.nodes, state, makeFlowCtx, baseExecCtx, opts);
            } else {
              await this.runSingleExecutable(
                key,
                target as Executable<any, any>,
                undefined,
                state,
                makeFlowCtx,
                baseExecCtx,
                opts,
              );
            }
          }
          break;
        }

        case 'parallel': {
          const entries = Object.entries(node.branches);
          const results = await Promise.all(
            entries.map(async ([key, branchSpec]) => {
              const fCtx = makeFlowCtx();
              if (branchSpec instanceof ConditionalExecutable) {
                if (!branchSpec.predicate(fCtx)) {
                  return [key, undefined] as const;
                }
                const mapped = branchSpec.mapInput ? branchSpec.mapInput(fCtx) : fCtx.input;
                const stepCtx = this.makeStepExecCtx(
                  baseExecCtx,
                  state,
                  key,
                  branchSpec.executable,
                  opts,
                );
                const out = await branchSpec.executable.execute(mapped, stepCtx);
                return [key, out] as const;
              }
              if ('executable' in branchSpec && !('kind' in branchSpec)) {
                const mapped = branchSpec.mapInput ? branchSpec.mapInput(fCtx) : fCtx.input;
                const stepCtx = this.makeStepExecCtx(
                  baseExecCtx,
                  state,
                  key,
                  branchSpec.executable,
                  opts,
                );
                const out = await branchSpec.executable.execute(mapped, stepCtx);
                return [key, out] as const;
              }
              const exec = branchSpec as Executable<any, any>;
              const mapper =
                exec instanceof BoundAgentSkill && exec.inputMapper ? exec.inputMapper : undefined;
              const mapped = mapper ? mapper(fCtx) : fCtx.input;
              const stepCtx = this.makeStepExecCtx(baseExecCtx, state, key, exec, opts);
              const out = await exec.execute(mapped, stepCtx);
              return [key, out] as const;
            }),
          );

          for (const [key, val] of results) {
            state.steps[key] = val;
          }
          this.store.updateRunProgress(baseExecCtx.runId, {
            iteration: state.iteration,
            state: state.steps,
          });
          break;
        }

        case 'loop': {
          const preLoopSteps = { ...state.steps };
          let converged = false;
          for (let iter = 0; iter < node.maxIterations; iter += 1) {
            if (iter > 0) {
              state.steps = { ...preLoopSteps };
            }
            state.iteration = iter;
            this.store.updateRunProgress(baseExecCtx.runId, {
              iteration: iter,
            });
            await this.executeNodes(node.bodyFlow.nodes, state, makeFlowCtx, baseExecCtx, opts);
            if (node.until(makeFlowCtx())) {
              converged = true;
              break;
            }
            state.prev = { ...state.steps };
          }
          if (!converged) {
            throw new MaxIterationsReachedError(node.bodyFlow.name, node.maxIterations);
          }
          break;
        }

        case 'batch': {
          const fCtx = makeFlowCtx();
          const items = await node.items(fCtx);
          const batchOutputs = await this.executeBatchNode(
            node.name,
            items,
            node.execute,
            node.concurrency,
            state,
            baseExecCtx,
            opts,
          );
          state.steps[node.name] = batchOutputs;
          this.store.updateRunProgress(baseExecCtx.runId, {
            iteration: state.iteration,
            currentStep: node.name,
            state: state.steps,
          });
          break;
        }

        case 'haltIf': {
          const fCtx = makeFlowCtx();
          if (node.predicate(fCtx)) {
            const rawBlocker = node.mapBlocker ? node.mapBlocker(fCtx) : 'Flow halted by haltIf';
            const reason = typeof rawBlocker === 'string' ? rawBlocker : rawBlocker.reason;
            const resolution = await this.store.haltRun(baseExecCtx.runId, reason);
            state.resolutions.push(resolution);
          }
          break;
        }
      }
    }
  }

  private makeStepExecCtx(
    baseExecCtx: ExecutionContext,
    state: { iteration: number; workDir: string },
    stepName: string,
    executable: Executable<any, any>,
    opts?: FlowRunOptions,
  ): ExecutionContext {
    return {
      ...baseExecCtx,
      iteration: state.iteration,
      stepName,
      workDir: state.workDir,
    };
  }

  private async runSingleExecutable(
    stepName: string,
    executable: Executable<any, any>,
    mapInput: ((ctx: FlowContext<any, any>) => any) | undefined,
    state: {
      iteration: number;
      steps: Record<string, any>;
      prev?: Record<string, any>;
      resolutions: unknown[];
      workDir: string;
    },
    makeFlowCtx: () => FlowContext<any, any>,
    baseExecCtx: ExecutionContext,
    opts?: FlowRunOptions,
  ): Promise<void> {
    this.store.updateRunProgress(baseExecCtx.runId, {
      iteration: state.iteration,
      currentStep: stepName,
    });
    const fCtx = makeFlowCtx();
    const inputVal = mapInput ? mapInput(fCtx) : fCtx.input;
    const stepCtx = this.makeStepExecCtx(baseExecCtx, state, stepName, executable, opts);
    const out = await executable.execute(inputVal, stepCtx);
    state.steps[stepName] = out;
    this.store.updateRunProgress(baseExecCtx.runId, {
      iteration: state.iteration,
      currentStep: stepName,
      state: state.steps,
    });
  }

  private async executeBatchNode<TItem, TOut>(
    stepName: string,
    items: readonly TItem[],
    executable: Executable<TItem, TOut>,
    concurrency: number,
    state: { iteration: number; workDir: string },
    baseExecCtx: ExecutionContext,
    opts?: FlowRunOptions,
  ): Promise<TOut[]> {
    if (items.length === 0) return [];

    if (items.length > 1 && executable instanceof BoundAgentSkill && executable.agent.modelDef) {
      const resolved = await executable.agent.modelDef.accountProvider.acquireAccount(this.store);
      if (resolved.driver.batch) {
        const systemPrompt = executable.buildSystemPrompt(
          baseExecCtx.projectDir,
          this.store,
          baseExecCtx.touchedPaths,
        );
        const outputJsonSchema = executable.getOutputJsonSchema();
        const parsedInputs = items.map((item) => executable.skill.inputSchema.parse(item));
        const requests: BatchItemRequest[] = parsedInputs.map((parsedIn, idx) => ({
          customId: `${stepName}-${idx}`,
          systemPrompt,
          userPrompt: executable.buildUserPrompt(parsedIn),
          outputJsonSchema,
        }));

        const invId = `inv-${randomUUID()}`;
        this.store.startInvocation({
          id: invId,
          runId: baseExecCtx.runId,
          iteration: state.iteration,
          stepName,
          actorName: executable.agent.name,
          actorKind: 'batch',
          accountId: resolved.accountId,
          modelId: executable.agent.modelDef.modelId,
        });

        const { batchId } = await resolved.driver.batch.submit(
          requests,
          executable.agent.modelDef.modelId,
          executable.agent.modelDef.options,
          executable.agent.modelDef.pricingAdapter,
        );

        const pollInterval = opts?.batchPollIntervalMs ?? 20;
        while (true) {
          if (baseExecCtx.signal.aborted) {
            await resolved.driver.batch.cancel?.(batchId);
            this.store.finishInvocation(invId, {
              status: 'fail',
              errorText: `Batch ${batchId} aborted`,
            });
            throw new Error(`Cloud batch ${batchId} aborted`);
          }

          const polled = await resolved.driver.batch.poll(batchId);
          if (polled.status === 'failed') {
            this.store.finishInvocation(invId, {
              status: 'fail',
              errorText: `Batch ${batchId} failed`,
            });
            throw new Error(`Cloud batch ${batchId} failed`);
          }
          if (polled.status === 'completed' && polled.results) {
            const results = polled.results;
            const finish = (status: 'pass' | 'fail', extra: { output?: unknown; errorText?: string }) => {
              const sum = (pick: (usage: TokenUsage) => number) =>
                results.reduce((total, r) => total + pick(r.usage), 0);
              const inputTokens = sum((u) => u.inputTokens);
              const outputTokens = sum((u) => u.outputTokens);
              const actualCosts = results.map((r) => r.usage.actualCostUsd);
              const equivalentCosts = results.map((r) => r.usage.equivalentCostUsd);
              this.store.recordAccountTokenUsage(
                resolved.accountId,
                inputTokens + outputTokens,
                resolved.quotaPolicy.tokenBudget,
              );
              this.store.finishInvocation(invId, {
                status,
                inputTokens,
                cachedInputTokens: sum((u) => u.cachedInputTokens),
                cacheWriteTokens: sum((u) => u.cacheWriteTokens ?? 0),
                outputTokens,
                actualCostUsd: actualCosts.includes(null) ? null : sumCosts(actualCosts).usd,
                equivalentCostUsd: equivalentCosts.includes(null) ? null : sumCosts(equivalentCosts).usd,
                ...extra,
              });
            };
            const byId = new Map(results.map((r) => [r.customId, r]));
            const outputs: TOut[] = [];

            try {
              for (let idx = 0; idx < items.length; idx += 1) {
                const resItem = byId.get(`${stepName}-${idx}`);
                if (!resItem || !resItem.ok) {
                  throw new Error(`Batch item ${stepName}-${idx} failed: ${resItem?.error ?? 'missing'}`);
                }
                const parsedOut = executable.skill.outputSchema.parse(resItem.structuredOutput);
                if (executable.skill.assertFn) {
                  await executable.skill.assertFn(parsedOut, parsedInputs[idx]!);
                }
                outputs.push(parsedOut);
              }
            } catch (err) {
              finish('fail', { errorText: err instanceof Error ? err.message : String(err) });
              throw err;
            }

            finish('pass', { output: outputs });
            return outputs;
          }
          await new Promise((r) => setTimeout(r, pollInterval));
        }
      }
    }

    const queue = new PQueue({ concurrency });
    return Promise.all(
      items.map(
        (item, idx) =>
          queue.add(async () => {
            const itemCtx: ExecutionContext = {
              ...baseExecCtx,
              iteration: state.iteration,
              stepName: `${stepName}[${idx}]`,
              workDir: state.workDir,
            };
            return executable.execute(item, itemCtx);
          }) as Promise<TOut>,
      ),
    );
  }
}
