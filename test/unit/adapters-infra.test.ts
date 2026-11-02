import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git } from '../../src/adapters/git/index.js';
import { jsonl } from '../../src/adapters/jsonl/index.js';
import { local } from '../../src/adapters/local/index.js';
import { ssh } from '../../src/adapters/ssh/index.js';
import type { MemoryItem, Resolver } from '../../src/kernel/index.js';

const resolver: Resolver = { env: (ref) => ref.name, port: () => 0 };
const signal = new AbortController().signal;

describe('infrastructure adapters', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'harness-infra-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs argv through the local runner with the given env and cwd', async () => {
    const runner = local.runner('local', { maxConcurrentSlots: 2 });
    expect.soft(runner).toMatchObject({ entity: 'runner', name: 'local', slotCount: 2 });
    const failed = await runner.backend.exec({ argv: ['sh', '-c', 'printf hi; exit 3'], env: {}, cwd: dir }, signal, resolver);
    expect.soft(failed).toMatchObject({ exitCode: 3, stdout: 'hi' });
    const quoted = await runner.backend.exec({ argv: ['printf', '%s', 'a b'], env: {} }, signal, resolver);
    expect.soft(quoted.stdout).toBe('a b');
    const withEnv = await runner.backend.exec({ argv: ['sh', '-c', 'printf "$GREETING"; pwd'], env: { GREETING: 'x' }, cwd: dir }, signal, resolver);
    expect.soft(withEnv.stdout.startsWith('x')).toBe(true);
    expect(withEnv.stdout).toContain(path.basename(dir));
  });

  it('declares an SSH host as a runner', () => {
    const box = ssh.host('box', { host: 'box', user: 'user', workDir: '/srv/app' });
    expect.soft(box).toMatchObject({ entity: 'runner', name: 'box', slotCount: 1 });
    expect(box.slots(3).slotCount).toBe(3);
  });

  it('prepares one git worktree per attempt and releases it', async () => {
    const repo = path.join(dir, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    writeFileSync(path.join(repo, 'README.md'), 'hello\n');
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);
    const root = path.join(dir, 'worktrees');
    const workspace = git.worktree('wt', { repo, root });
    expect.soft(workspace).toMatchObject({ entity: 'workspace', name: 'wt' });
    const prepared = await workspace.backend.prepare('attempt-1');
    expect.soft(prepared.path).toBe(path.join(root, 'attempt-1'));
    expect.soft(existsSync(path.join(prepared.path, 'README.md'))).toBe(true);
    expect.soft((await workspace.backend.prepare('attempt-1')).path).toBe(prepared.path);
    expect.soft(execFileSync('git', ['-C', repo, 'worktree', 'list'], { encoding: 'utf8' })).toContain('harness/attempt-1');
    await workspace.backend.release('attempt-1');
    expect.soft(existsSync(prepared.path)).toBe(false);
    expect(execFileSync('git', ['-C', repo, 'worktree', 'list'], { encoding: 'utf8' })).not.toContain('attempt-1');
  });

  it('keeps memory items in a JSONL file across reopening', async () => {
    const file = path.join(dir, 'memory.jsonl');
    const item = (id: string, journal: string, status: MemoryItem['status']): MemoryItem => ({
      id,
      memoryKind: 'experience',
      journal,
      createdAt: new Date('2026-11-01T00:00:00Z'),
      status,
      when: { kinds: [], roles: [], resources: [], facets: [] },
      text: `lesson ${id}`,
      trackRecord: { used: 0, succeeded: 0 },
    });
    const store = jsonl.memoryStore('mem', { path: file });
    await store.put(item('a', 'lessons', 'candidate'));
    await store.put(item('b', 'lessons', 'active'));
    await store.put(item('c', 'taste', 'active'));
    expect.soft((await store.list({ journal: 'lessons' })).map((entry) => entry.id)).toEqual(['a', 'b']);
    expect.soft((await store.list({ journal: 'lessons', status: ['active'] })).map((entry) => entry.id)).toEqual(['b']);
    await store.update('a', { status: 'active', trackRecord: { used: 2, succeeded: 1 } });
    const reopened = jsonl.memoryStore('mem', { path: file });
    const items = await reopened.list({ journal: 'lessons', status: ['active'] });
    expect.soft(items.map((entry) => [entry.id, entry.trackRecord])).toEqual([
      ['a', { used: 2, succeeded: 1 }],
      ['b', { used: 0, succeeded: 0 }],
    ]);
    expect(items[0]?.createdAt).toBeInstanceOf(Date);
  });
});
