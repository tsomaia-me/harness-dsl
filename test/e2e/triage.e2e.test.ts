import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { triageHarness } from '../../examples/triage/harness.js';
import { Runtime } from '../../src/engine/runtime.js';
import { processResolver } from '../../src/engine/resolver.js';
import type { LedgerEvent } from '../../src/kernel/index.js';

const live = process.env.HARNESS_LIVE === '1';

describe.skipIf(!live)('support triage on the Anthropic API', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('classifies conversations, sends the easy ones by policy, asks a human for the rest, and folds the decisions into a metric', { timeout: 10 * 60_000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harness-triage-'));
    dirs.push(dir);
    process.env.HARNESS_OPS_TOKEN = 'e2e-token';
    const { harness, drivers, ops } = triageHarness({ stateDir: dir });
    const runtime = new Runtime({ harness, drivers, resolver: processResolver(), holder: 'e2e' });
    await runtime.start();
    try {
      const headers = { authorization: 'Bearer e2e-token', 'content-type': 'application/json' };
      const create = async (id: string, from: string, text: string) =>
        ((await (await fetch(`${ops.url()}/operations/work.create`, { method: 'POST', headers, body: JSON.stringify({ lane: 'conversations', attributes: { id, from, text } }) })).json()) as { unitId: string }).unitId;
      const easy = await create('c1', 'sam@example.com', 'Hi, where can I download my invoice for last month? No rush.');
      const angry = await create('c2', 'kim@example.com', 'You charged me twice for the same order and nobody answers. I want my money back today.');
      for (let round = 0; round < 3; round += 1) await runtime.tick();

      const easyRecord = (await runtime.find(easy))!;
      const angryRecord = (await runtime.find(angry))!;
      expect.soft(easyRecord.unit).toMatchObject({ state: 'Answered', position: 'terminal' });
      expect.soft(angryRecord.unit.attempt).toMatchObject({ status: 'blocked', blockedOn: 'decision', halt: 'send' });
      const decisions: Extract<LedgerEvent, { type: 'decisionRecorded' }>[] = [];
      for await (const { event } of runtime.ledger.read({ types: ['decisionRecorded'] })) if (event.type === 'decisionRecorded') decisions.push(event);
      expect.soft(decisions.map((event) => [event.resolvedBy, event.by])).toEqual([['policy', 'auto-send']]);
      expect.soft(decisions[0]?.facets?.map((facet) => facet.facet)).toEqual(['category', 'urgency']);

      const resolved = (await (await fetch(`${ops.url()}/operations/halts.resolve`, { method: 'POST', headers, body: JSON.stringify({ unitId: angry, decision: { send: false } }) })).json()) as { outcome: { kind: string; exit?: string } };
      expect.soft(resolved.outcome).toEqual({ kind: 'exit', exit: 'escalated' });
      await runtime.tick();
      const telemetry = (await (await fetch(`${ops.url()}/operations/telemetry.read`, { method: 'POST', headers, body: '{}' })).json()) as { halts: { halt: string; decisions: { samples: number } }[] };
      expect.soft(telemetry.halts).toEqual([{ halt: 'send', decisions: expect.objectContaining({ samples: 2 }) }]);
      expect.soft(runtime.metrics.rate(harness.metricList[0] as never).samples).toBe(2);
      expect(readFileSync(path.join(dir, 'BOARD.md'), 'utf8')).toMatch(/\| c2 \| Escalated \| terminal \|/);
    } finally {
      await runtime.stop();
    }
  });
});
