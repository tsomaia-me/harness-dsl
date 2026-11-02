import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { defineWorkspace, type WorkspaceDef } from '../../dsl/runners.js';
import type { WorkspaceBackend } from '../../kernel/backends.js';

export interface GitWorktreeOptions {
  readonly repo: string;
  /** Where the worktrees live; one directory per attempt. Default: `<repo>/.harness/worktrees`. */
  readonly root?: string;
  /** The commit the worktree starts from; `HEAD` of the repository when none is given. */
  readonly base?: string;
}

/** A git worktree per attempt on branch `harness/<attemptId>`; the path is a function of the attempt, so a restart finds it. */
export function worktreeBackend(options: GitWorktreeOptions): WorkspaceBackend {
  const root = options.root ?? path.join(options.repo, '.harness', 'worktrees');
  const dirOf = (attemptId: string) => path.join(root, attemptId);
  return {
    async prepare(attemptId) {
      const dir = dirOf(attemptId);
      if (!existsSync(dir)) {
        mkdirSync(root, { recursive: true });
        await simpleGit(options.repo).raw(['worktree', 'add', '-B', `harness/${attemptId}`, dir, options.base ?? 'HEAD']);
      }
      return { path: dir };
    },
    async release(attemptId) {
      const dir = dirOf(attemptId);
      const git = simpleGit(options.repo);
      if (existsSync(dir)) await git.raw(['worktree', 'remove', '--force', dir]).catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
      await git.raw(['worktree', 'prune']).catch(() => undefined);
      await git.raw(['branch', '-D', `harness/${attemptId}`]).catch(() => undefined);
    },
  };
}

export const git = {
  worktree(name: string, options: GitWorktreeOptions): WorkspaceDef {
    return defineWorkspace(name, worktreeBackend(options));
  },
};
