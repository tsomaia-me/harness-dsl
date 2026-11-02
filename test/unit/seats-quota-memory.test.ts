import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SqliteLedger } from '../../src/adapters/sqlite/ledger.js';
import { quota as sqliteQuota, type SqliteQuotaPartition } from '../../src/adapters/sqlite/quota.js';
import { H, type FlowDef, type HarnessDef } from '../../src/dsl/index.js';
import { foldAccountState } from '../../src/engine/quota.js';
import { Runtime } from '../../src/engine/runtime.js';
import { AccountRefusedError } from '../../src/kernel/index.js';
import type { Account, LedgerEvent, MemoryItem, MemoryStore, Model, ModelDriver, ModelRequest, ModelResponse, Resolver } from '../../src/kernel/index.js';

const resolver: Resolver = { env: (ref) => ref.name, port: () => 0 };
const T = new Date('2026-11-02T12:00:00Z');
const minutes = (n: number) => new Date(T.getTime() + n * 60_000);
const hours = (n: number) => minutes(n * 60);
const days = (n: number) => hours(n * 24);

function account(name: string, quota: Account['quota']): Account<'test'> {
  return { entity: 'account', name, driver: 'test', credential: { ref: 'env', name: `${name.toUpperCase()}_TOKEN` }, quota };
}

function model(name: string, batch = false): Model<'test'> {
  return { entity: 'model', name, id: `${name}-id`, driver: 'test', batch };
}

type Respond = (request: ModelRequest) => ModelResponse;

class ScriptedDriver implements ModelDriver<'test'> {
  public readonly name = 'test-driver';
  public readonly driver = 'test' as const;
  public readonly hooks = true;
  public readonly requests: ModelRequest[] = [];
  public readonly batches = new Map<string, readonly ModelRequest[]>();
  public collectReady = false;
  public constructor(private readonly respond: Respond) {}
  public serves() {
    return true;
  }
  public async invoke(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return this.respond(request);
  }
  public async submitBatch(requests: readonly ModelRequest[]) {
    const jobId = `batch-${this.batches.size + 1}`;
    this.batches.set(jobId, requests);
    return { jobId };
  }
  public async collectBatch(jobId: string) {
    if (!this.collectReady) return undefined;
    return this.batches.get(jobId)!.map((request) => this.respond(request));
  }
}

const Open = H.state('Open', 'pending');
const Done = H.terminal('Done', 'success');
const Failed = H.terminal('Failed', 'failure');
const Task = H.kind('Task').attributes(z.object({ title: z.string() })).states(Open, Done, Failed).key((a) => a.title).initial(Open);
const workerRole = H.role('worker').input(z.object({ title: z.string() })).output(z.object({ verdict: z.string() })).prompt((i) => `work on ${i.title}`).intents('record');

function laneOf(flow: FlowDef<any, any, any, 'done', any>) {
  return H.lane('tasks', Task).supply(H.operator).handler(flow, { exits: { done: Done } }).retry({ tries: 0, exhausted: Failed }).on(H.cancel, { enter: Failed });
}

async function events(ledger: SqliteLedger, type?: LedgerEvent['type']): Promise<LedgerEvent[]> {
  const out: LedgerEvent[] = [];
  for await (const { event } of ledger.read(type ? { types: [type] } : {})) out.push(event);
  return out;
}

describe('quota partitions', () => {
  let dir: string;
  let partition: SqliteQuotaPartition;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'harness-quota-'));
    partition = sqliteQuota('shared', { path: path.join(dir, 'quota.sqlite') });
  });
  afterEach(() => {
    partition.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('folds everyone\'s utilization and cooldowns but only this harness\'s share', async () => {
    const x = account('x', partition);
    await partition.append([
      { type: 'consumed', account: 'x', harness: 'alpha', tokens: 600, costUsd: 0.6, at: hours(-2) },
      { type: 'consumed', account: 'x', harness: 'beta', tokens: 400, costUsd: 0.4, at: hours(-1) },
      { type: 'consumed', account: 'other', harness: 'alpha', tokens: 9_000, costUsd: 9, at: hours(-1) },
      { type: 'windowObserved', account: 'x', harness: 'alpha', window: 'w7d', utilization: 0.8, resetsAt: days(3), at: minutes(-30) },
      { type: 'windowObserved', account: 'x', harness: 'beta', window: 'w5h', utilization: 0.99, resetsAt: minutes(-1), at: hours(-2) },
      { type: 'cooldown', account: 'x', harness: 'beta', until: minutes(10), reason: 'rate limited', at: minutes(-5) },
    ]);
    const alpha = await foldAccountState(x, 'alpha', 0.5, T);
    expect.soft(alpha).toMatchObject({ utilization: 0.8, shareCap: 0.5, windowResetsAt: days(3), cooldownUntil: minutes(10) });
    expect.soft(alpha.shareUsed).toBeCloseTo(0.48, 9);
    const beta = await foldAccountState(x, 'beta', 1, T);
    expect.soft(beta.shareUsed).toBeCloseTo(0.32, 9);
    expect.soft(beta.shareCap).toBe(1);
    const later = await foldAccountState(x, 'alpha', 0.5, minutes(11));
    expect(later.cooldownUntil).toBeUndefined();
  });

  it('counts the share from the last observed reset of the longest window', async () => {
    const x = account('x', partition);
    await partition.append([
      { type: 'windowObserved', account: 'x', harness: 'alpha', window: 'w7d', utilization: 0.9, resetsAt: days(-1), at: days(-3) },
      { type: 'consumed', account: 'x', harness: 'alpha', tokens: 1_000, costUsd: 1, at: days(-2) },
      { type: 'windowObserved', account: 'x', harness: 'alpha', window: 'w7d', utilization: 0.5, resetsAt: days(6), at: hours(-1) },
      { type: 'consumed', account: 'x', harness: 'alpha', tokens: 100, costUsd: 0.1, at: minutes(-30) },
      { type: 'consumed', account: 'x', harness: 'beta', tokens: 100, costUsd: 0.1, at: minutes(-20) },
    ]);
    const alpha = await foldAccountState(x, 'alpha', 1, T);
    expect.soft(alpha.utilization).toBe(0.5);
    expect(alpha.shareUsed).toBeCloseTo(0.25, 9);
  });

  it('admits one live process per harness name and lets a dead holder be taken over', async () => {
    expect.soft(await partition.join('alpha', 'holder-1', 50)).toEqual({ accepted: true });
    expect.soft(await partition.join('alpha', 'holder-2', 50)).toEqual({ accepted: false, heldBy: 'holder-1' });
    expect.soft(await partition.join('alpha', 'holder-1', 50)).toEqual({ accepted: true });
    expect.soft(await partition.join('beta', 'holder-2', 50)).toEqual({ accepted: true });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await partition.join('alpha', 'holder-2', 50)).toEqual({ accepted: true });
  });
});

describe('seats, pools and memory in the engine', () => {
  let dir: string;
  let partition: SqliteQuotaPartition;
  let clock: Date;
  const now = () => clock;
  const ledgers: SqliteLedger[] = [];
  const runtimes: Runtime[] = [];

  function ledgerNamed(name: string): SqliteLedger {
    const ledger = new SqliteLedger({ path: path.join(dir, `${name}.sqlite`) });
    ledgers.push(ledger);
    return ledger;
  }

  async function started(harness: HarnessDef, driver: ModelDriver): Promise<Runtime> {
    const runtime = new Runtime({ harness, drivers: [driver], resolver, now, holder: `${harness.name}-holder` });
    await runtime.start();
    runtimes.push(runtime);
    return runtime;
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'harness-seats-'));
    partition = sqliteQuota('shared', { path: path.join(dir, 'quota.sqlite') });
    clock = T;
  });
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) await runtime.stop();
    for (const ledger of ledgers.splice(0)) ledger.close();
    partition.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('shares cooldowns across harnesses on one partition and keeps each harness\'s share', async () => {
    const x = account('x', partition);
    const f = account('f', partition);
    const m = model('m');
    const pool = H.pool('subs').accounts(x).fallback(f);
    const worker = H.seat('worker').role(workerRole).model(m).pool(pool);
    const flow = H.flow('work').input(z.object({ title: z.string() })).step('work', worker, (ctx) => ({ title: ctx.unit.attributes.title })).exit('done');
    const lane = laneOf(flow);
    const harnessOf = (name: string, ledger: SqliteLedger) => H.harness(name).ledger(ledger).lanes(lane).scheduler(H.scheduler('s').standard(lane)).share(f, 0.5);

    const alphaDriver = new ScriptedDriver((request) => {
      if (request.account.name === 'x') throw new AccountRefusedError('x', 'rateLimited', minutes(10), 'Rate limit reached', [{ window: 'w5h', utilization: 1, resetsAt: minutes(10) }]);
      return { output: { verdict: 'ok' }, costUsd: 1, tokens: 1_000, windows: [{ window: 'w5h', utilization: 0.9, resetsAt: hours(4) }] };
    });
    const alphaLedger = ledgerNamed('alpha');
    const alpha = await started(harnessOf('alpha', alphaLedger), alphaDriver);
    const first = (await alpha.createUnit(lane, { title: 'first' }, { source: 'test' }))!;
    expect.soft(await alpha.startAttempt(first)).toEqual({ kind: 'exit', exit: 'done' });
    expect.soft(alphaDriver.requests.map((request) => request.account.name)).toEqual(['x', 'f']);
    const invocations = (await events(alphaLedger, 'invocation')) as Extract<LedgerEvent, { type: 'invocation' }>[];
    expect.soft(invocations.map((event) => [event.account, event.ok, event.number, event.tokens ?? 0])).toEqual([
      ['x', false, 1, 0],
      ['f', true, 2, 1_000],
    ]);
    const recorded: string[] = [];
    for await (const event of partition.read({ accounts: ['x', 'f'], since: days(-7) })) recorded.push(`${event.type}:${event.account}:${event.harness}`);
    expect.soft(recorded).toEqual(['cooldown:x:alpha', 'windowObserved:x:alpha', 'consumed:f:alpha', 'windowObserved:f:alpha']);

    const second = (await alpha.createUnit(lane, { title: 'second' }, { source: 'test' }))!;
    const blocked = await alpha.startAttempt(second);
    expect.soft(blocked).toMatchObject({ kind: 'blocked', on: 'budget', resumeAt: minutes(10) });
    const timers = (await events(alphaLedger, 'timerSet')) as Extract<LedgerEvent, { type: 'timerSet' }>[];
    expect.soft(timers.map((event) => event.fireAt)).toEqual([minutes(10)]);

    const betaDriver = new ScriptedDriver(() => ({ output: { verdict: 'ok' }, costUsd: 1, tokens: 10 }));
    const beta = await started(harnessOf('beta', ledgerNamed('beta')), betaDriver);
    const third = (await beta.createUnit(lane, { title: 'third' }, { source: 'test' }))!;
    expect.soft(await beta.startAttempt(third)).toEqual({ kind: 'exit', exit: 'done' });
    expect(betaDriver.requests.map((request) => request.account.name)).toEqual(['f']);
  });

  it('refuses a second live process under one harness name', async () => {
    const x = account('x', partition);
    const pool = H.pool('subs').accounts(x);
    const worker = H.seat('worker').role(workerRole).model(model('m')).pool(pool);
    const flow = H.flow('work').input(z.object({ title: z.string() })).step('work', worker, (ctx) => ({ title: ctx.unit.attributes.title })).exit('done');
    const lane = laneOf(flow);
    const harness = H.harness('alpha').ledger(ledgerNamed('alpha')).lanes(lane).scheduler(H.scheduler('s').standard(lane));
    await started(harness, new ScriptedDriver(() => ({ output: { verdict: 'ok' }, costUsd: 0, tokens: 1 })));
    const twin = new Runtime({ harness: H.harness('alpha').ledger(ledgerNamed('alpha-twin')).lanes(lane).scheduler(H.scheduler('s').standard(lane)), drivers: [new ScriptedDriver(() => ({ output: {}, costUsd: 0, tokens: 0 }))], resolver, now, holder: 'twin' });
    await expect(twin.start()).rejects.toThrow(/partition "shared" refuses harness "alpha": held by "alpha-holder"/);
  });

  it('evaluates a distinct policy in seat order, refuses a duplicate, and keeps each seat\'s series', async () => {
    const x = account('x', partition);
    const X = model('X');
    const Y = model('Y');
    const pool = H.pool('subs').accounts(x);
    let wanted = X;
    const ab = H.policy.model('ab', [X, Y], (ctx) => (ctx.seat.name === 'a' ? wanted : (ctx.peers.find((peer) => peer.seat.name === 'a')?.model ?? X)), { distinct: true });
    const a = H.seat('a').role(workerRole).model(ab).pool(pool);
    const b = H.seat('b').role(workerRole).model(ab).pool(pool);
    const flow = H.flow('pair')
      .input(z.object({ title: z.string() }))
      .step('a', a, (ctx) => ({ title: ctx.unit.attributes.title }))
      .step('b', b, (ctx) => ({ title: ctx.unit.attributes.title }))
      .exit('done');
    const lane = laneOf(flow);
    const ledger = ledgerNamed('ab');
    const driver = new ScriptedDriver(() => ({ output: { verdict: 'ok' }, costUsd: 0, tokens: 1 }));
    const runtime = await started(H.harness('ab').ledger(ledger).lanes(lane).scheduler(H.scheduler('s').standard(lane)), driver);

    const first = (await runtime.createUnit(lane, { title: 'first' }, { source: 'test' }))!;
    expect.soft(await runtime.startAttempt(first)).toEqual({ kind: 'exit', exit: 'done' });
    wanted = Y;
    const second = (await runtime.createUnit(lane, { title: 'second' }, { source: 'test' }))!;
    expect.soft(await runtime.startAttempt(second)).toEqual({ kind: 'exit', exit: 'done' });

    expect.soft(driver.requests.map((request) => `${request.seat}:${request.model}`)).toEqual(['a:X-id', 'b:Y-id', 'a:Y-id', 'b:X-id']);
    const refused = (await events(ledger, 'policyRefused')) as Extract<LedgerEvent, { type: 'policyRefused' }>[];
    expect.soft(refused.map((event) => [event.policy, event.kept])).toEqual([
      ['ab', 'Y'],
      ['ab', 'X'],
    ]);
    expect.soft(refused[0]?.reason).toMatch(/seat "b" chose "X", which seat "a" holds/);
    const decisions = (await events(ledger, 'policyDecision')) as Extract<LedgerEvent, { type: 'policyDecision' }>[];
    expect.soft(decisions.filter((event) => event.policy === 'ab').map((event) => event.value)).toEqual(['X', 'X', 'Y', 'Y']);
    await runtime.tick();
    expect.soft(runtime.metrics.attempts({ of: Task, seat: a }).samples).toBe(2);
    expect.soft(runtime.metrics.attempts({ of: Task, seat: a, model: Y }).samples).toBe(1);
    expect(runtime.metrics.attempts({ of: Task, seat: b, model: X }).samples).toBe(1);
  });

  it('recalls by the journal\'s policy, never the store\'s order, and settles the track record', async () => {
    const item = (id: string, when: Partial<MemoryItem['when']>, extra: Partial<MemoryItem> = {}): MemoryItem => ({
      id,
      memoryKind: 'experience',
      journal: 'lessons',
      createdAt: days(-1),
      status: 'active',
      when: { kinds: [], roles: [], resources: [], facets: [], ...when },
      text: `lesson ${id}`,
      trackRecord: { used: 0, succeeded: 0 },
      ...extra,
    });
    const puts: MemoryItem[] = [];
    const updates: { id: string; change: Parameters<MemoryStore['update']>[1] }[] = [];
    const items = [
      item('general', {}),
      item('other-kind', { kinds: ['Other'] }),
      item('for-kind', { kinds: ['Task'] }, { trackRecord: { used: 4, succeeded: 1 } }),
      item('candidate', { kinds: ['Task'], roles: ['worker'] }, { status: 'candidate' }),
      item('for-kind-and-role', { kinds: ['Task'], roles: ['worker'] }),
      item('taste-general', {}, { journal: 'taste', memoryKind: 'taste', trackRecord: { used: 2, succeeded: 2 } }),
      item('taste-kind', { kinds: ['Task'] }, { journal: 'taste', memoryKind: 'taste' }),
    ];
    const store: MemoryStore = {
      entity: 'memoryStore',
      name: 'store',
      put: async (put) => {
        puts.push(put);
      },
      list: async (filter) => items.filter((candidate) => candidate.journal === filter.journal && (!filter.status || filter.status.includes(candidate.status))),
      update: async (id, change) => {
        updates.push({ id, change });
      },
    };
    const bySpecificity = H.policy.recall('by-specificity', (ctx) =>
      [...ctx.candidates]
        .sort((p, q) => q.specificity - p.specificity || q.trackRecord.succeeded - p.trackRecord.succeeded)
        .slice(0, ctx.limit)
        .map((candidate) => candidate.item),
    );
    const lessons = H.journal('lessons', H.memory('experience', 'experience')).store(store).recall(bySpecificity).readBy(workerRole).recordedBy(workerRole);
    const taste = H.journal('taste', H.memory('taste', 'taste')).store(store).readBy(workerRole);
    const x = account('x', partition);
    const worker = H.seat('worker').role(workerRole).model(model('m')).pool(H.pool('subs').accounts(x));
    const flow = H.flow('work').input(z.object({ title: z.string() })).step('work', worker, (ctx) => ({ title: ctx.unit.attributes.title })).exit('done');
    const lane = laneOf(flow);
    const ledger = ledgerNamed('memory');
    const driver = new ScriptedDriver(() => ({
      output: { verdict: 'ok' },
      costUsd: 0,
      tokens: 1,
      recorded: [
        { journal: 'lessons', text: 'learned something', when: { kinds: ['Task'], roles: [], resources: [], facets: [] } },
        { journal: 'taste', text: 'not allowed', when: { kinds: [], roles: [], resources: [], facets: [] } },
      ],
    }));
    const runtime = await started(H.harness('memory').ledger(ledger).lanes(lane).journals(lessons, taste).scheduler(H.scheduler('s').standard(lane)), driver);
    const unit = (await runtime.createUnit(lane, { title: 'first' }, { source: 'test' }))!;
    expect.soft(await runtime.startAttempt(unit)).toEqual({ kind: 'exit', exit: 'done' });

    expect.soft(driver.requests[0]?.memory.map((recalled) => recalled.id)).toEqual(['for-kind-and-role', 'for-kind', 'general', 'taste-kind', 'taste-general']);
    const invocation = (await events(ledger, 'invocation'))[0] as Extract<LedgerEvent, { type: 'invocation' }>;
    expect.soft(invocation.memory).toEqual(['for-kind-and-role', 'for-kind', 'general', 'taste-kind', 'taste-general']);
    const decisions = (await events(ledger, 'policyDecision')) as Extract<LedgerEvent, { type: 'policyDecision' }>[];
    expect.soft(decisions.map((event) => [event.policy, event.value])).toEqual([['by-specificity', ['for-kind-and-role', 'for-kind', 'general']]]);
    expect.soft(updates.map((update) => [update.id, update.change.trackRecord])).toEqual([
      ['for-kind-and-role', { used: 1, succeeded: 1 }],
      ['for-kind', { used: 5, succeeded: 2 }],
      ['general', { used: 1, succeeded: 1 }],
      ['taste-kind', { used: 1, succeeded: 1 }],
      ['taste-general', { used: 3, succeeded: 3 }],
    ]);
    expect(puts.map((put) => [put.journal, put.status, put.text, put.when.kinds])).toEqual([['lessons', 'candidate', 'learned something', ['Task']]]);
  });

  it('submits a batch through the seat\'s driver and collects it in request order', async () => {
    const x = account('x', partition);
    const grader = H.seat('grader').role(workerRole).model({ ...model('big'), batch: true as const }).pool(H.pool('subs').accounts(x));
    const grade = H.batch('grade', grader);
    const flow = H.flow('work')
      .input(z.object({ title: z.string() }))
      .step('grade', grade, (ctx) => [{ title: `${ctx.unit.attributes.title}-1` }, { title: `${ctx.unit.attributes.title}-2` }])
      .exit('done');
    const lane = laneOf(flow);
    const ledger = ledgerNamed('batch');
    const driver = new ScriptedDriver((request) => ({ output: { verdict: `graded ${(request.input as { title: string }).title}` }, costUsd: 0.5, tokens: 100 }));
    const runtime = await started(H.harness('batch').ledger(ledger).lanes(lane).scheduler(H.scheduler('s').standard(lane)), driver);
    const unit = (await runtime.createUnit(lane, { title: 'essay' }, { source: 'test' }))!;
    expect.soft(await runtime.startAttempt(unit)).toMatchObject({ kind: 'blocked', on: 'job', resumeAt: minutes(10) });
    expect.soft([...driver.batches.values()][0]?.map((request) => [request.idempotencyKey.replace(/^attempt-[^/]+\//, ''), request.account.name, request.model])).toEqual([
      ['grade#0', 'x', 'big-id'],
      ['grade#1', 'x', 'big-id'],
    ]);
    clock = minutes(10);
    await runtime.tick();
    expect.soft((await runtime.find(unit))?.unit.attempt?.status).toBe('blocked');
    driver.collectReady = true;
    clock = minutes(20);
    await runtime.tick();
    const record = await runtime.find(unit);
    expect.soft(record?.unit.state).toBe('Done');
    const graded = (await events(ledger, 'stepEnded')).find((event) => event.type === 'stepEnded' && event.step === 'grade');
    expect.soft(graded).toMatchObject({ ok: true, output: [{ verdict: 'graded essay-1' }, { verdict: 'graded essay-2' }] });
    const invocations = (await events(ledger, 'invocation')) as Extract<LedgerEvent, { type: 'invocation' }>[];
    expect.soft(invocations.map((event) => [event.viaJob, event.ok, event.tokens ?? 0, event.costUsd])).toEqual([
      [true, true, 0, 0],
      [true, true, 200, 1],
    ]);
    const consumed: number[] = [];
    for await (const event of partition.read({ accounts: ['x'], since: days(-1) })) if (event.type === 'consumed') consumed.push(event.tokens);
    expect(consumed).toEqual([200]);
  });
});
