import type { AgentPlugin, Executable, HookDecision } from '../types.js';

export interface StopCheckOutput {
  readonly passed: boolean;
  readonly summary?: string;
}

export interface StopCommandHookOptions<TInput, TOutput> {
  readonly mapInput?: (ctx: { runId: string; workDir: string }) => TInput;
  readonly verdict?: (output: TOutput) => HookDecision;
}

function passedVerdict(output: StopCheckOutput): HookDecision {
  return { allow: output.passed === true, reason: output.summary };
}

export function stopCommandHook<TInput, TOutput extends StopCheckOutput>(
  command: Executable<TInput, TOutput>,
  opts?: StopCommandHookOptions<TInput, TOutput>,
): AgentPlugin;
export function stopCommandHook<TInput, TOutput>(
  command: Executable<TInput, TOutput>,
  opts: StopCommandHookOptions<TInput, TOutput> & { readonly verdict: (output: TOutput) => HookDecision },
): AgentPlugin;
export function stopCommandHook<TInput, TOutput>(
  command: Executable<TInput, TOutput>,
  opts?: StopCommandHookOptions<TInput, TOutput>,
): AgentPlugin {
  const verdict = opts?.verdict ?? (passedVerdict as unknown as (output: TOutput) => HookDecision);
  return {
    name: `stopCommandHook:${command.name}`,
    stop: {
      async handle(_event, ctx) {
        const input = opts?.mapInput
          ? opts.mapInput({ runId: ctx.runId, workDir: ctx.workDir })
          : ({ worktreePath: ctx.workDir, workDir: ctx.workDir } as unknown as TInput);

        const output = await command.execute(input, {
          runId: ctx.runId,
          iteration: 0,
          stepName: `stop-hook:${command.name}`,
          projectDir: ctx.store.projectDir,
          workDir: ctx.workDir,
          touchedPaths: [],
          store: ctx.store,
          signal: new AbortController().signal,
        });

        const decision = verdict(output);
        return decision.allow
          ? { allow: true }
          : { allow: false, reason: decision.reason ?? `Stop check "${command.name}" failed` };
      },
    },
  };
}
