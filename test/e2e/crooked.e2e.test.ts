import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { crookedHarness } from '../../examples/crooked/harness.js';
import { Runtime } from '../../src/engine/runtime.js';
import { processResolver } from '../../src/engine/resolver.js';
import type { LedgerEvent } from '../../src/kernel/index.js';

const live = process.env.HARNESS_LIVE === '1';
/** The product repository the run clones: `HARNESS_PRODUCT_REPO`, else the checkout beside this one. */
const PRODUCT_REPO = process.env.HARNESS_PRODUCT_REPO ?? path.resolve(import.meta.dirname, '../../../CrookedDuke');
const CHEAPEST = 'claude-haiku-5-5';

async function eventsOf<T extends LedgerEvent['type']>(ledger: { read(query: { types: readonly LedgerEvent['type'][] }): AsyncIterable<{ event: LedgerEvent }> }, type: T): Promise<Extract<LedgerEvent, { type: T }>[]> {
  const out: Extract<LedgerEvent, { type: T }>[] = [];
  for await (const { event } of ledger.read({ types: [type] })) if (event.type === type) out.push(event as Extract<LedgerEvent, { type: T }>);
  return out;
}

function hasCommand(name: string): boolean {
  try {
    execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** The product's checks run through `pnpm`; when the machine has none, corepack supplies it in a private directory for this run. */
function providePnpm(dir: string): void {
  if (hasCommand('pnpm')) return;
  const bin = path.join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  execFileSync('corepack', ['enable', '--install-directory', bin, 'pnpm'], { stdio: 'inherit' });
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
  process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0';
}

describe.skipIf(!live || !existsSync(PRODUCT_REPO))('the product harness, live, on a clone of the product repository', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('runs an epic\'s ticket through the builder, the three records and the fix rounds to the owner\'s sign-off over MCP, and abandons it', { timeout: 45 * 60_000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harness-crooked-'));
    dirs.push(dir);
    providePnpm(dir);
    const repo = path.join(dir, 'repo');
    execFileSync('git', ['clone', '--quiet', '--local', PRODUCT_REPO, repo]);
    const stateDir = path.join(dir, 'state');
    const { harness, drivers, owner, quota } = crookedHarness({ repo, stateDir, models: { opus: CHEAPEST, sonnet: CHEAPEST, haiku: CHEAPEST }, supervisorPort: 0 });
    const runtime = new Runtime({ harness, drivers, resolver: processResolver(), hooks: { port: 0 }, holder: 'e2e' });
    await runtime.start();
    const client = new Client({ name: 'owner-session', version: '0.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(owner.url())));
      const call = async (name: string, args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0]!.text) as Record<string, unknown>;
      const ticket = {
        id: 'CD-PROVE',
        title: 'Name the harness proving run in the README',
        criteria: ['README.md says, in one sentence under its first paragraph, that the repository was driven once by the harness-dsl proving run'],
        sections: [],
        rulings: ['Touch README.md only.', 'Commit on the worktree branch you are in.', 'Run `pnpm check:touched --direct` before you stop; a root Markdown change reaches no package, so it passes at once.'],
      };
      const created = await call('work_create', { lane: 'epics', attributes: { id: 'EP-PROVE', title: 'Proving run', tickets: [ticket] } });
      expect.soft(created.unitId).toMatch(/^unit-/);
      await runtime.tick();
      const tickets = await runtime.ledger.units({ lane: 'tickets' });
      expect.soft(tickets.map((record) => record.unit.key)).toEqual(['CD-PROVE']);
      await runtime.tick();
      const ticketId = tickets[0]!.unit.id;
      let record = (await runtime.find(ticketId))!;
      const invocations = await eventsOf(runtime.ledger, 'invocation');
      const loops = await eventsOf(runtime.ledger, 'loopIteration');
      process.stdout.write(`${JSON.stringify({ attempt: record.unit.attempt, rounds: loops.length, invocations: invocations.map((event) => ({ step: event.step, executable: event.executable, account: event.account, ok: event.ok, tokens: event.tokens, durationMs: event.durationMs })), ended: (await eventsOf(runtime.ledger, 'attemptEnded')).map((event) => [event.outcome, event.detail]) })}\n`);
      expect.soft(record.unit.attempt).toMatchObject({ status: 'blocked', blockedOn: 'decision' });
      if (record.unit.attempt?.halt === 'needs-you') {
        const ruled = await call('halts_resolve', { unitId: ticketId, decision: { ruling: 'proceed to sign-off; the proving run judges the flow, not the findings' } });
        process.stdout.write(`needs-you: ${JSON.stringify(ruled)}\n`);
        record = (await runtime.find(ticketId))!;
      }
      expect.soft(record.unit.attempt).toMatchObject({ status: 'blocked', blockedOn: 'decision', halt: 'sign-off' });
      expect.soft(invocations.filter((event) => event.executable === 'builder').every((event) => event.ok)).toBe(true);
      expect.soft(new Set(invocations.map((event) => event.executable))).toEqual(new Set(['builder', 'reviewer', 'verifier', 'judge']));
      const resolved = await call('halts_resolve', { unitId: ticketId, decision: { merge: false, note: 'a proving run lands nothing' } });
      expect.soft(resolved.outcome).toMatchObject({ kind: 'exit', exit: 'abandoned' });
      expect.soft((await runtime.find(ticketId))?.unit).toMatchObject({ state: 'Abandoned', position: 'terminal' });
      await runtime.tick();
      expect.soft((await runtime.find(created.unitId as string))?.unit).toMatchObject({ state: 'Cancelled', position: 'terminal' });
      const telemetry = await call('telemetry_read', {});
      process.stdout.write(`telemetry: ${JSON.stringify(telemetry)}\n`);
      expect(existsSync(path.join(stateDir, 'BOARD.md'))).toBe(true);
    } finally {
      await client.close().catch(() => undefined);
      await runtime.stop();
      quota.close();
      harness.ledgerDef!.close();
    }
  });
});
