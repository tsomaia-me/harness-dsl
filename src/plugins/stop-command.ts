import type { AgentPlugin, Executable, HookDecision } from '../types.js';

export interface StopCheckOutput {
  readonly passed: boolean;
  readonly summary?: string;
}

export type StopVerdict = Pick<HookDecision, 'allow' | 'reason'>;

export interface StopHookContext {
  readonly runId: string;
  readonly workDir: string;
}

type MapInputOption<TInput> = [{ workDir: string }] extends [TInput]
  ? { readonly mapInput?: (ctx: StopHookContext) => TInput }
  : { readonly mapInput: (ctx: StopHookContext) => TInput };

type VerdictOption<TOutput> = [TOutput] extends [StopCheckOutput]
  ? { readonly verdict?: (output: TOutput) => StopVerdict }
  : { readonly verdict: (output: TOutput) => StopVerdict };

export const DEFAULT_MAX_CONSECUTIVE_BLOCKS = 3;

export type StopCommandHookOptions<TInput, TOutput> = MapInputOption<TInput> &
  VerdictOption<TOutput> & { readonly maxConsecutiveBlocks?: number };

type OptionsArgument<TInput, TOutput> = {} extends StopCommandHookOptions<TInput, TOutput>
  ? [opts?: StopCommandHookOptions<TInput, TOutput>]
  : [opts: StopCommandHookOptions<TInput, TOutput>];

function passedVerdict(output: unknown): StopVerdict {
  const check = output as StopCheckOutput;
  return { allow: check.passed === true, reason: check.summary };
}

export function stopCommandHook<TInput, TOutput>(
  command: Executable<TInput, TOutput>,
  ...[opts]: OptionsArgument<TInput, TOutput>
): AgentPlugin {
  const options = opts as
    | {
        readonly mapInput?: (ctx: StopHookContext) => TInput;
        readonly verdict?: (output: TOutput) => StopVerdict;
        readonly maxConsecutiveBlocks?: number;
      }
    | undefined;
  const maxConsecutiveBlocks = options?.maxConsecutiveBlocks ?? DEFAULT_MAX_CONSECUTIVE_BLOCKS;
  const blocksByInvocation = new Map<string, number>();
  const mapInput = options?.mapInput ?? ((ctx: StopHookContext) => ({ workDir: ctx.workDir }) as TInput);
  const verdict = options?.verdict ?? passedVerdict;
  return {
    name: `stopCommandHook:${command.name}`,
    stop: {
      async handle(_event, ctx) {
        const output = await command.execute(mapInput({ runId: ctx.runId, workDir: ctx.workDir }), {
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
        const blocks = decision.allow ? 0 : (blocksByInvocation.get(ctx.invocationId) ?? 0) + 1;
        if (decision.allow || blocks > maxConsecutiveBlocks) {
          blocksByInvocation.delete(ctx.invocationId);
          return { allow: true };
        }
        blocksByInvocation.set(ctx.invocationId, blocks);
        return { allow: false, reason: decision.reason ?? `Stop check "${command.name}" failed` };
      },
    },
  };
}
