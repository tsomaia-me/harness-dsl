import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Areas, Bug, bug, builderRole, Failed, Fixed } from '../../examples/coding/harness.js';
import { geminiCli } from '../../src/adapters/gemini-cli/index.js';
import { git } from '../../src/adapters/git/index.js';
import { local } from '../../src/adapters/local/index.js';
import { sqlite } from '../../src/adapters/sqlite/index.js';
import { H } from '../../src/dsl/index.js';
import { Runtime } from '../../src/engine/runtime.js';
import { processResolver } from '../../src/engine/resolver.js';
import type { LedgerEvent } from '../../src/kernel/index.js';

const live = process.env.HARNESS_LIVE === '1';
const PROJECT = path.join(import.meta.dirname, '../../examples/coding/project');

async function eventsOf<T extends LedgerEvent['type']>(ledger: { read(query: { types: readonly LedgerEvent['type'][] }): AsyncIterable<{ event: LedgerEvent }> }, type: T): Promise<Extract<LedgerEvent, { type: T }>[]> {
  const out: Extract<LedgerEvent, { type: T }>[] = [];
  for await (const { event } of ledger.read({ types: [type] })) if (event.type === type) out.push(event as Extract<LedgerEvent, { type: T }>);
  return out;
}

describe.skipIf(!live)('a guarded step on the Gemini CLI', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('fixes the sample project in a worktree under the hook guards and reruns the checks', { timeout: 15 * 60_000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harness-gemini-coding-'));
    dirs.push(dir);
    const repo = path.join(dir, 'repo');
    cpSync(PROJECT, repo, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, '-c', 'user.name=harness', '-c', 'user.email=harness@example.com', 'commit', '-q', '-m', 'sample project with a failing test']);
    const stateDir = path.join(dir, 'state');

    const quota = sqlite.quota('gemini', { path: path.join(stateDir, 'quota.sqlite') });
    const account = geminiCli.account('gemini', { apiKey: H.env('GEMINI_API_KEY'), quota });
    const model = geminiCli.model('flash-lite', { id: 'gemini-3.5-flash-lite' });
    const builder = H.seat('builder').role(builderRole).model(model).pool(H.pool('gemini').accounts(account));
    const runner = local.runner('local', { maxConcurrentSlots: 1 });
    const checks = H.command('checks').argv(['node', '--experimental-strip-types', '--test', 'test/sum.test.ts']).runner(runner).effect('repeatable');
    const workspace = git.worktree('worktree', { repo, root: path.join(stateDir, 'worktrees') }).withAreas(Areas, { src: ['src/**'], test: ['test/**'] });
    const fix = H.flow('fix')
      .input(bug)
      .step('build', builder, (ctx) => ({ title: ctx.unit.attributes.title, hint: ctx.unit.attributes.hint }), { workspace, guard: { leases: Areas, beforeStop: checks } })
      .step('checks', checks)
      .exit('fixed');
    const fixes = H.lane('fixes', Bug).supply(H.operator).handler(fix, { exits: { fixed: Fixed } }).retry({ tries: 0, exhausted: Failed }).on(H.cancel, { enter: Failed });
    const harness = H.harness('gemini-coding').ledger(sqlite.ledger({ path: path.join(stateDir, 'ledger.sqlite') })).lanes(fixes).scheduler(H.scheduler('s').standard(fixes));
    const runtime = new Runtime({
      harness,
      drivers: [geminiCli.driver({ workDir: repo, sessionDir: path.join(stateDir, 'sessions') })],
      resolver: processResolver(),
      hooks: { port: 0 },
      holder: 'e2e',
    });
    await runtime.start();
    try {
      const unit = (await runtime.createUnit(fixes, { id: 'sum-1', title: 'sum subtracts instead of adding', hint: 'The function in src/sum.ts returns a - b; it must return a + b.' }, { source: 'e2e' }))!;
      const outcome = await runtime.startAttempt(unit);
      const invocations = await eventsOf(runtime.ledger, 'invocation');
      const taken = await eventsOf(runtime.ledger, 'leaseTaken');
      const ended = await eventsOf(runtime.ledger, 'attemptEnded');
      process.stdout.write(`${JSON.stringify({ outcome, invocations: invocations.map((event) => ({ step: event.step, ok: event.ok, tokens: event.tokens, costUsd: event.costUsd, durationMs: event.durationMs })), leases: taken.map((event) => event.resource), ended: ended.map((event) => [event.outcome, event.detail]) })}\n`);
      expect.soft(outcome).toEqual({ kind: 'exit', exit: 'fixed' });
      expect.soft(invocations.map((event) => [event.executable, event.ok])).toEqual([
        ['builder', true],
        ['checks', true],
      ]);
      expect.soft(taken.map((event) => event.resource)).toContain('area:src');
      const worktree = path.join(stateDir, 'worktrees', ended[0] ? ended[0].attemptId : '');
      expect.soft(readFileSync(path.join(worktree, 'src', 'sum.ts'), 'utf8')).toMatch(/a \+ b/);
      expect((await runtime.find(unit))?.unit).toMatchObject({ state: 'Fixed', position: 'terminal' });
    } finally {
      await runtime.stop();
    }
  });
});
