import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import type { ExecutionContext, FlowMiddleware } from '../types.js';

export interface GitWorktreeOptions {
  readonly baseBranch?: string;
  readonly worktreesRootDir?: string;
  readonly cleanupOnSuccess?: boolean;
}

export function gitWorktreeIsolation(opts?: GitWorktreeOptions): FlowMiddleware {
  const baseBranch = opts?.baseBranch ?? 'HEAD';
  const cleanupOnSuccess = opts?.cleanupOnSuccess ?? false;

  return {
    name: 'gitWorktreeIsolation',
    async wrap<TInput, TOutput>(
      _input: TInput,
      ctx: ExecutionContext,
      next: (updatedCtx: ExecutionContext) => Promise<TOutput>,
    ): Promise<TOutput> {
      const rootDir =
        opts?.worktreesRootDir ?? path.join(ctx.projectDir, '.harness', 'worktrees');
      mkdirSync(rootDir, { recursive: true });
      const worktreePath = path.join(rootDir, ctx.runId);
      const branchName = `harness/${ctx.runId}`;
      const git = simpleGit(ctx.projectDir);

      await git.raw(['worktree', 'add', '-B', branchName, worktreePath, baseBranch]);
      ctx.store.updateRunProgress(ctx.runId, {
        state: { worktreePath, branchName },
      });

      try {
        const result = await next({
          ...ctx,
          workDir: worktreePath,
        });
        if (cleanupOnSuccess) {
          await git.raw(['worktree', 'remove', '--force', worktreePath]);
          rmSync(worktreePath, { recursive: true, force: true });
        }
        return result;
      } catch (err) {
        throw err;
      }
    },
  };
}
