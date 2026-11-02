import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codingHarness } from '../../examples/coding/harness.js';
import { Runtime } from '../../src/engine/runtime.js';
import { processResolver } from '../../src/engine/resolver.js';
import type { LedgerEvent } from '../../src/kernel/index.js';

const live = process.env.HARNESS_LIVE === '1';
const PROJECT = path.join(import.meta.dirname, '../../examples/coding/project');

async function eventsOf(ledger: { read(query: { types: readonly LedgerEvent['type'][] }): AsyncIterable<{ event: LedgerEvent }> }, type: LedgerEvent['type']): Promise<LedgerEvent[]> {
  const out: LedgerEvent[] = [];
  for await (const { event } of ledger.read({ types: [type] })) out.push(event);
  return out;
}

describe.skipIf(!live)('the coding loop on the signed-in Claude Code CLI', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('fixes the sample project in a guarded worktree, reruns the checks, waits for approval over HTTP, and lands the fix', { timeout: 20 * 60_000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harness-coding-'));
    dirs.push(dir);
    const repo = path.join(dir, 'repo');
    cpSync(PROJECT, repo, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, '-c', 'user.name=harness', '-c', 'user.email=harness@example.com', 'commit', '-q', '-m', 'sample project with a failing test']);
    process.env.HARNESS_OPS_TOKEN = 'e2e-token';

    const stateDir = path.join(dir, 'state');
    const { harness, drivers, ops } = codingHarness({ repo, stateDir });
    const runtime = new Runtime({ harness, drivers, resolver: processResolver(), hooks: { port: 0 }, holder: 'e2e' });
    await runtime.start();
    try {
      const headers = { authorization: 'Bearer e2e-token', 'content-type': 'application/json' };
      const created = (await (await fetch(`${ops.url()}/operations/work.create`, { method: 'POST', headers, body: JSON.stringify({ lane: 'fixes', attributes: { id: 'sum-1', title: 'sum subtracts instead of adding', hint: 'The function in src/sum.ts returns a - b; it must return a + b.' } }) })).json()) as { unitId: string };
      expect(created.unitId).toMatch(/^unit-/);

      await runtime.tick();
      const record = (await runtime.find(created.unitId))!;
      expect.soft(record.unit.attempt).toMatchObject({ status: 'blocked', blockedOn: 'decision', halt: 'approval' });

      const taken = await eventsOf(runtime.ledger, 'leaseTaken');
      expect.soft(taken.map((event) => (event.type === 'leaseTaken' ? event.resource : ''))).toContain('area:src');
      const invocations = (await eventsOf(runtime.ledger, 'invocation')).filter((event): event is Extract<LedgerEvent, { type: 'invocation' }> => event.type === 'invocation');
      expect.soft(invocations.map((event) => [event.executable, event.ok])).toEqual([
        ['builder', true],
        ['checks', true],
      ]);
      const worktree = path.join(stateDir, 'worktrees', record.unit.attempt!.id);
      expect.soft(readFileSync(path.join(worktree, 'src', 'sum.ts'), 'utf8')).toMatch(/a \+ b/);
      expect.soft(readFileSync(path.join(worktree, 'test', 'sum.test.ts'), 'utf8')).toBe(readFileSync(path.join(PROJECT, 'test', 'sum.test.ts'), 'utf8'));

      const resolved = (await (await fetch(`${ops.url()}/operations/halts.resolve`, { method: 'POST', headers, body: JSON.stringify({ unitId: created.unitId, decision: { approved: true } }) })).json()) as { outcome: { kind: string; exit?: string } };
      expect.soft(resolved.outcome).toEqual({ kind: 'exit', exit: 'fixed' });
      expect.soft((await runtime.find(created.unitId))?.unit).toMatchObject({ state: 'Fixed', position: 'terminal' });
      const released = await eventsOf(runtime.ledger, 'leaseReleased');
      expect.soft(released.length).toBeGreaterThanOrEqual(1);

      const telemetry = (await (await fetch(`${ops.url()}/operations/telemetry.read`, { method: 'POST', headers, body: '{}' })).json()) as { seats: { seat: string; attempts: { succeeded: number } }[] };
      expect.soft(telemetry.seats).toEqual([{ seat: 'builder', model: 'builder-model', attempts: expect.objectContaining({ succeeded: 1 }) }]);
      expect.soft(existsSync(path.join(stateDir, 'BOARD.md'))).toBe(true);
      expect(readFileSync(path.join(stateDir, 'TELEMETRY.md'), 'utf8')).toContain('| builder | builder-model | 1 | 1 | 0 |');
      process.stdout.write(`invocations: ${JSON.stringify(invocations.map((event) => ({ step: event.step, tokens: event.tokens, costUsd: event.costUsd, durationMs: event.durationMs })))}\n`);
    } finally {
      await runtime.stop();
    }
  });
});
