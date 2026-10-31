import type { AgentPlugin, Executable } from '../types.js';

export function stopCommandHook<TInput = any, TOutput = any>(
  command: Executable<TInput, TOutput>,
  mapInput?: (ctx: { runId: string; workDir: string }) => TInput,
): AgentPlugin {
  return {
    name: `stopCommandHook:${command.name}`,
    hookTypes: ['Stop'],
    async onStop(_payload, ctx) {
      const input = mapInput
        ? mapInput({ runId: ctx.runId, workDir: ctx.workDir })
        : ({ worktreePath: ctx.workDir, workDir: ctx.workDir } as unknown as TInput);

      const res = (await command.execute(input, {
        runId: ctx.runId,
        iteration: 0,
        stepName: `stop-hook:${command.name}`,
        projectDir: ctx.store.projectDir,
        workDir: ctx.workDir,
        slotIndex: 0,
        slotPorts: [18000, 18001, 18002],
        touchedPaths: [],
        store: ctx.store,
        signal: new AbortController().signal,
      })) as Record<string, unknown>;

      const passed =
        typeof res === 'object' && res !== null
          ? res.passed !== undefined
            ? Boolean(res.passed)
            : res.exitCode !== undefined
              ? res.exitCode === 0
              : true
          : Boolean(res);

      if (!passed) {
        const reason =
          (typeof res === 'object' &&
            res !== null &&
            (typeof res.summary === 'string'
              ? res.summary
              : typeof res.stderr === 'string'
                ? res.stderr
                : JSON.stringify(res))) ||
          `Stop check "${command.name}" failed`;
        return {
          allow: false,
          reason,
        };
      }

      return { allow: true };
    },
  };
}
