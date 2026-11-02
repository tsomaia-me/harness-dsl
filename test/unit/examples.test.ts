import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codingHarness } from '../../examples/coding/harness.js';
import { crookedHarness } from '../../examples/crooked/harness.js';
import { triageHarness } from '../../examples/triage/harness.js';
import { claudeCodeGuardProtocol } from '../../src/adapters/claude-code/index.js';
import { validate } from '../../src/dsl/index.js';
import { Runtime } from '../../src/engine/runtime.js';
import type { ModelDriver, ModelRequest, ModelResponse, Resolver } from '../../src/kernel/index.js';
import { eventsOf } from './scenarios/doubles.js';

const resolver: Resolver = { env: (ref) => `secret-${ref.name}`, port: () => 0 };

class ScriptedClaudeCode implements ModelDriver<'claude-code'> {
  public readonly name = 'scripted-claude-code';
  public readonly driver = 'claude-code' as const;
  public readonly hooks = true;
  public readonly guardProtocol = claudeCodeGuardProtocol;
  public readonly requests: ModelRequest[] = [];
  public constructor(private readonly respond: (request: ModelRequest) => ModelResponse) {}
  public serves() {
    return true;
  }
  public async invoke(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return this.respond(request);
  }
}

describe('the example harnesses', () => {
  let dir: string;
  let repo: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'harness-examples-'));
    repo = path.join(dir, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    writeFileSync(path.join(repo, 'README.md'), 'x\n');
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('validate', () => {
    const coding = codingHarness({ repo, stateDir: path.join(dir, 'coding') });
    const triage = triageHarness({ stateDir: path.join(dir, 'triage') });
    const crooked = crookedHarness({ repo, stateDir: path.join(dir, 'crooked') });
    expect.soft(validate(coding.harness)).toEqual([]);
    expect.soft(validate(triage.harness)).toEqual([]);
    expect(validate(crooked.harness)).toEqual([]);
    coding.quota.close();
    crooked.quota.close();
    for (const harness of [coding.harness, triage.harness, crooked.harness]) harness.ledgerDef!.close();
  });

  it('runs an epic through its tickets: build, three records in parallel, fix rounds until clean, the owner\'s sign-off', async () => {
    const { harness, lanes, quota } = crookedHarness({ repo, stateDir: path.join(dir, 'crooked') });
    let round = 0;
    const driver = new ScriptedClaudeCode((request): ModelResponse => {
      if (request.seat === 'builder') {
        round += 1;
        return { output: { sha: `sha-${round}`, checksRun: ['pnpm test'], deferred: [], decisions: [] }, costUsd: 0, tokens: 10 };
      }
      if (request.seat === 'reviewer') return { output: { blocking: round === 1 ? ['src/a.ts:3 unchecked input'] : [], notes: [] }, costUsd: 0, tokens: 5 };
      return { output: { blocking: [], notes: [] }, costUsd: 0, tokens: 5 };
    });
    const runtime = new Runtime({ harness, drivers: [driver], resolver, holder: 'examples', hooks: { port: 0 } });
    await runtime.start();
    try {
      const epicId = (await runtime.createUnit(lanes.epics, { id: 'EP-1', title: 'Wallet', tickets: [{ id: 'TIC-1', title: 'Show the balance', criteria: ['the balance shows'], sections: ['§2.1'], rulings: [] }] }, { source: 'test' }))!;
      await runtime.tick();
      const tickets = await runtime.ledger.units({ lane: 'tickets' });
      expect.soft(tickets.map((record) => [record.unit.key, record.unit.parentId === epicId, record.unit.attributes.epic])).toEqual([['TIC-1', true, 'EP-1']]);
      await runtime.tick();
      const ticket = (await runtime.find(tickets[0]!.unit.id))!;
      expect.soft(ticket.unit.attempt).toMatchObject({ status: 'blocked', blockedOn: 'decision', halt: 'sign-off' });
      expect.soft(driver.requests.map((request) => request.seat)).toEqual(['builder', 'reviewer', 'verifier', 'judge', 'builder', 'reviewer', 'verifier', 'judge']);
      expect.soft((driver.requests[4]!.input as { fixList: string[] }).fixList).toEqual(['src/a.ts:3 unchecked input']);
      expect.soft(driver.requests[0]?.guard).toMatchObject({ leases: true, stop: true });
      expect.soft((await eventsOf(runtime.ledger, 'haltNotAsked')).length).toBe(1);
      await runtime.resolveHalt(ticket.unit.id, { merge: false, note: 'not now' }, 'owner');
      expect.soft((await runtime.find(ticket.unit.id))?.unit).toMatchObject({ state: 'Abandoned', position: 'terminal' });
      await runtime.tick();
      expect((await runtime.find(epicId))?.unit).toMatchObject({ state: 'Cancelled', position: 'terminal' });
    } finally {
      await runtime.stop();
      quota.close();
      harness.ledgerDef!.close();
    }
  });
});
