import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SqliteLedger } from '../../src/adapters/sqlite/ledger.js';
import { defineRunner, defineWorkspace, H, type FlowDef } from '../../src/dsl/index.js';
import { flowVersion } from '../../src/engine/address.js';
import { Runtime } from '../../src/engine/runtime.js';
import { AccountRefusedError } from '../../src/kernel/index.js';
import { ControlError } from '../../src/engine/control.js';
import type { LedgerEvent, ModelDriver, ModelRequest, ModelResponse, Observer, Resolver, RunnerBackend, SequencedEvent, Store } from '../../src/kernel/index.js';
import { eventsOf, fakeAccount, fakeClient, fakeModel, recordingQuota, ScriptedDriver } from './scenarios/doubles.js';

const resolver: Resolver = { env: (ref) => ref.name, port: () => 0 };
const T = new Date('2026-11-02T12:00:00Z');
const minutes = (n: number) => new Date(T.getTime() + n * 60_000);
type Event<T extends LedgerEvent['type']> = Extract<LedgerEvent, { type: T }>;

const Open = H.state('Open', 'pending');
const Done = H.terminal('Done', 'success');
const Failed = H.terminal('Failed', 'failure');
const ChildOpen = H.state('ChildOpen', 'pending');
const ChildDone = H.terminal('ChildDone', 'success');
const Task = H.kind('Task').attributes(z.object({ title: z.string(), tags: z.array(z.string()).optional() })).states(Open, Done, Failed).key((a) => a.title).initial(Open);
const Child = H.kind('Child').attributes(z.object({ title: z.string(), n: z.number() })).states(ChildOpen, ChildDone).key((a) => `${a.title}:${a.n}`).initial(ChildOpen);
const workerRole = H.role('worker').input(z.object({ title: z.string() })).output(z.object({ verdict: z.string() })).prompt((i) => `work on ${i.title}`);
const approval = H.halt('approval').decision(z.object({ approved: z.boolean() }));
const budget = H.halt('budget').decision(z.object({ proceed: z.boolean() }));
const tag = H.signal('tag').payload(z.object({ tag: z.string() }));
const redo = H.signal('redo');
const Parked = H.state('Parked', 'waiting');
const Ordered = H.kind('Ordered').attributes(z.object({ title: z.string(), after: z.string().optional() })).states(Open, Parked, Done, Failed).key((a) => a.title).initial(Open);
const db = H.resource('db');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function laneOf(flow: FlowDef<any, any, any, 'done', any>, retry: { tries: number; exhausted?: typeof Failed } = { tries: 0, exhausted: Failed }) {
  return H.lane('tasks', Task)
    .supply(H.operator)
    .handler(flow, { exits: { done: Done } })
    .retry(retry.exhausted ? { tries: retry.tries, exhausted: retry.exhausted } : { tries: retry.tries })
    .on(tag, { update: (a, p) => ({ ...a, tags: [...(a.tags ?? []), p.tag] }), at: ['done'] })
    .on(H.cancel, { enter: Failed });
}

class HangingDriver implements ModelDriver<'test'> {
  public readonly name = 'hanging';
  public readonly driver = 'test' as const;
  public readonly hooks = true;
  public readonly requests: ModelRequest[] = [];
  public release: (() => void) | undefined;
  public serves() {
    return true;
  }
  public async invoke(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    await new Promise<void>((resolve) => {
      this.release = resolve;
      request.cancel?.addEventListener('abort', () => resolve(), { once: true });
    });
    if (request.cancel?.aborted) throw new Error('aborted');
    return { output: { verdict: 'late' }, costUsd: 0.5, tokens: 10 };
  }
}

describe('the engine after the cold review', () => {
  let dir: string;
  let ledger: SqliteLedger;
  let clock: Date;
  const now = () => clock;
  const runtimes: Runtime[] = [];
  const quota = recordingQuota('q');
  const account = fakeAccount('x', 'test', quota);
  const model = fakeModel('m', 'test', 'm-id');
  const pool = H.pool('p').accounts(account);
  const seatOf = (seatName = 'worker') => H.seat(seatName).role(workerRole).model(model).pool(pool);

  async function started(harness: ReturnType<typeof H.harness>, driver: ModelDriver, extra: Partial<ConstructorParameters<typeof Runtime>[0]> = {}): Promise<Runtime> {
    const runtime = new Runtime({ harness, drivers: [driver], resolver, now, holder: `h-${runtimes.length}`, ...extra });
    await runtime.start();
    runtimes.push(runtime);
    return runtime;
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'harness-engine-review-'));
    ledger = new SqliteLedger({ path: path.join(dir, 'ledger.sqlite') });
    clock = T;
    quota.events.length = 0;
  });
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) await runtime.stop().catch(() => undefined);
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('renews the writer claim and the partition seat while it runs, and lets go on stop', async () => {
    const lane = laneOf(H.flow('f').input(Task.attributeSchema!).exit('done'));
    const harness = H.harness('claims').ledger(ledger).lanes(lane).scheduler(H.scheduler('s').standard(lane));
    const runtime = await started(harness, new ScriptedDriver(() => ({ output: {}, costUsd: 0, tokens: 0 })), { claimTtlMs: 120 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(runtime.createUnit(lane, { title: 'late' }, { source: 'test' })).resolves.toMatch(/^unit-/);
    const rival = new Runtime({ harness, drivers: [new ScriptedDriver(() => ({ output: {}, costUsd: 0, tokens: 0 }))], resolver, now, holder: 'rival', claimTtlMs: 120 });
    await expect(rival.start()).rejects.toThrow(/ledger is held/);
    await runtime.stop();
    await rival.start();
    runtimes.push(rival);
  });

  it('a cancel during a running seat step aborts the call and ends the attempt once', async () => {
    const driver = new HangingDriver();
    const lane = laneOf(H.flow('f').input(Task.attributeSchema!).step('work', seatOf(), (ctx) => ({ title: ctx.unit.attributes.title })).exit('done'));
    const runtime = await started(H.harness('cancel').ledger(ledger).lanes(lane).scheduler(H.scheduler('s').standard(lane)), driver);
    const unit = (await runtime.createUnit(lane, { title: 'slow' }, { source: 'test' }))!;
    const walking = runtime.startAttempt(unit);
    while (driver.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    await runtime.cancelUnit(unit, 'stop it', 'client:owner');
    expect.soft(await walking).toEqual({ kind: 'cancelled' });
    expect.soft(driver.requests[0]?.cancel?.aborted).toBe(true);
    const ended = (await eventsOf(ledger, 'attemptEnded')) as Event<'attemptEnded'>[];
    expect.soft(ended.map((event) => event.outcome)).toEqual(['cancelled']);
    const transitions = (await eventsOf(ledger, 'transition')) as Event<'transition'>[];
    expect.soft(transitions.map((event) => event.to)).toEqual(['Open', 'Failed']);
    expect((await runtime.find(unit))?.unit).toMatchObject({ state: 'Failed', position: 'terminal' });
  });

  it('a thrown mapper is a step failure the lane handles, never a running attempt nobody drives', async () => {
    const lane = laneOf(
      H.flow('f')
        .input(Task.attributeSchema!)
        .step('work', seatOf(), () => {
          throw new Error('mapper exploded');
        })
        .exit('done'),
      { tries: 0 },
    );
    const runtime = await started(H.harness('throws').ledger(ledger).lanes(lane).scheduler(H.scheduler('s').standard(lane)).clients(fakeClient('ops', [H.ops.attempts.recover])), new ScriptedDriver(() => ({ output: { verdict: 'ok' }, costUsd: 0, tokens: 1 })));
    const unit = (await runtime.createUnit(lane, { title: 'boom' }, { source: 'test' }))!;
    expect.soft(await runtime.startAttempt(unit)).toMatchObject({ kind: 'failed', step: 'work', error: expect.stringContaining('mapper exploded') });
    expect.soft((await runtime.find(unit))?.unit.attempt).toMatchObject({ status: 'blocked', blockedOn: 'stepFailure' });
    await runtime.recover(unit, 'abandon', 'client:ops');
    expect((await runtime.find(unit))?.unit).toMatchObject({ state: 'Failed', position: 'terminal' });
  });

  it('a halt from a driver without sessions resumes with the decision, names the halt, and records no interruption', async () => {
    let calls = 0;
    const driver = new ScriptedDriver((request) => {
      calls += 1;
      if (request.resume) return { output: { verdict: `after ${request.resume.halt}` }, costUsd: 0, tokens: 1 };
      return { output: null, costUsd: 0, tokens: 1, halt: { halt: 'approval', ask: 'ship?' } };
    });
    const lane = laneOf(H.flow('f').input(Task.attributeSchema!).step('work', seatOf(), (ctx) => ({ title: ctx.unit.attributes.title }), { halts: [approval] }).exit('done'));
    const runtime = await started(H.harness('resume').ledger(ledger).lanes(lane).scheduler(H.scheduler('s').standard(lane)).clients(fakeClient('owner', [H.ops.resolve(approval)])), driver);
    const unit = (await runtime.createUnit(lane, { title: 'ask' }, { source: 'test' }))!;
    expect.soft(await runtime.startAttempt(unit)).toMatchObject({ kind: 'blocked', on: 'decision', ask: 'ship?' });
    expect.soft(await runtime.resolveHalt(unit, { approved: true }, 'owner')).toEqual({ kind: 'exit', exit: 'done' });
    expect.soft(calls).toBe(2);
    expect.soft(driver.requests[1]?.resume).toEqual({ halt: 'approval', decision: { approved: true } });
    expect.soft(await eventsOf(ledger, 'attemptInterrupted')).toEqual([]);
    const outputs = (await eventsOf(ledger, 'stepEnded')) as Event<'stepEnded'>[];
    expect(outputs.map((event) => event.output)).toEqual([{ verdict: 'after approval' }]);
  });

  it('blocks on budget with a timer at the soonest refusal when every account refuses', async () => {
    const driver = new ScriptedDriver(() => {
      throw new AccountRefusedError('x', 'rateLimited', minutes(7), 'slow down');
    });
    const lane = laneOf(H.flow('f').input(Task.attributeSchema!).step('work', seatOf(), (ctx) => ({ title: ctx.unit.attributes.title })).exit('done'));
    const runtime = await started(H.harness('budget').ledger(ledger).lanes(lane).scheduler(H.scheduler('s').standard(lane)), driver);
    const unit = (await runtime.createUnit(lane, { title: 'x' }, { source: 'test' }))!;
    expect.soft(await runtime.startAttempt(unit)).toMatchObject({ kind: 'blocked', on: 'budget', resumeAt: minutes(7) });
    const timers = (await eventsOf(ledger, 'timerSet')) as Event<'timerSet'>[];
    expect(timers.map((event) => event.fireAt)).toEqual([minutes(7)]);
  });

  it('a spawn with no children finishes at once, and a spawn inside a when resumes when its children end', async () => {
    const childLane = H.lane('children', Child).handler(H.flow('c').input(Child.attributeSchema!).exit('done'), { exits: { done: ChildDone } }).retry({ tries: 0, exhausted: ChildDone }).on(H.cancel, { enter: ChildDone });
    const flow = H.flow('f')
      .input(Task.attributeSchema!)
      .spawn('none', childLane, () => [])
      .when('fan', (ctx) => ctx.unit.attributes.title === 'fan', (body) => body.spawn('kids', childLane, (ctx) => [{ title: ctx.unit.attributes.title, n: 1 }, { title: ctx.unit.attributes.title, n: 2 }]))
      .exit('done');
    const lane = laneOf(flow);
    const runtime = await started(H.harness('spawn').ledger(ledger).lanes(lane, childLane).scheduler(H.scheduler('s').standard(lane, childLane)), new ScriptedDriver(() => ({ output: {}, costUsd: 0, tokens: 0 })));
    const plain = (await runtime.createUnit(lane, { title: 'plain' }, { source: 'test' }))!;
    expect.soft(await runtime.startAttempt(plain)).toEqual({ kind: 'exit', exit: 'done' });
    const fan = (await runtime.createUnit(lane, { title: 'fan' }, { source: 'test' }))!;
    expect.soft(await runtime.startAttempt(fan)).toMatchObject({ kind: 'blocked', on: 'children' });
    const created = (await eventsOf(ledger, 'unitCreated')) as Event<'unitCreated'>[];
    const kids = created.filter((event) => event.lane === 'children');
    expect.soft(kids).toHaveLength(2);
    const seqs: number[] = [];
    for await (const { seq, event } of ledger.read({ types: ['unitCreated'] })) if (event.type === 'unitCreated' && event.lane === 'children') seqs.push(seq);
    expect.soft(seqs[1]! - seqs[0]!).toBeLessThanOrEqual(2);
    for (let round = 0; round < 3; round += 1) await runtime.tick();
    expect((await runtime.find(fan))?.unit).toMatchObject({ state: 'Done', position: 'terminal' });
  });

  it('a call recovered through the driver\'s session is recorded like any other, with its usage and memory', async () => {
    const driver = new ScriptedDriver(() => ({ output: { verdict: 'ok' }, costUsd: 0.25, tokens: 40 }));
    const finished = new Map<string, ModelResponse>();
    let running = true;
    const recovering: ModelDriver<'test'> = { ...driver, invoke: (request) => driver.invoke(request), session: async (key) => (running ? { status: 'running' } : finished.has(key) ? { status: 'finished', response: finished.get(key)! } : { status: 'lost' }), serves: () => true };
    const lane = laneOf(H.flow('f').input(Task.attributeSchema!).step('work', seatOf(), (ctx) => ({ title: ctx.unit.attributes.title })).exit('done'));
    const harness = H.harness('session').ledger(ledger).lanes(lane).scheduler(H.scheduler('s').standard(lane));
    const first = await started(harness, recovering, { claimTtlMs: 150 });
    const unit = (await first.createUnit(lane, { title: 'x' }, { source: 'test' }))!;
    const record = await first.record(unit);
    const attemptId = 'attempt-cut';
    await first.append([
      { type: 'demandGranted', lane: 'tasks', unitId: unit, serviceClass: 'standard', at: T },
      { type: 'attemptStarted', unitId: unit, attemptId, number: 1, fromStep: 'work', flow: 'f', flowVersion: flowVersion(lane.handlerDef!.flow), serviceClass: 'standard', at: T },
      { type: 'stepStarted', attemptId, step: 'work', iteration: 0, at: T },
    ]);
    void record;
    finished.set(`${attemptId}/work`, { output: { verdict: 'recovered' }, costUsd: 0.75, tokens: 99, sessionId: 'sess-cut' });
    await first.stop();
    runtimes.pop();
    const second = await started(harness, recovering);
    expect.soft((await second.find(unit))?.unit.attempt).toMatchObject({ status: 'blocked', blockedOn: 'job', step: 'work' });
    expect.soft((await eventsOf(ledger, 'timerSet')).map((event) => (event as Event<'timerSet'>).fireAt)).toEqual([minutes(1)]);
    running = false;
    clock = minutes(2);
    await second.tick();
    expect.soft(driver.requests).toHaveLength(0);
    expect.soft((await second.find(unit))?.unit).toMatchObject({ state: 'Done', position: 'terminal', costUsd: 0.75 });
    const invocations = (await eventsOf(ledger, 'invocation')) as Event<'invocation'>[];
    expect.soft(invocations.map((event) => [event.ok, event.costUsd, event.tokens, event.sessionId])).toEqual([[true, 0.75, 99, 'sess-cut']]);
    expect.soft((await eventsOf(ledger, 'attemptInterrupted'))).toHaveLength(1);
    const consumed: number[] = [];
    for await (const event of account.quota.read({ accounts: ['x'], since: minutes(-1) })) if (event.type === 'consumed') consumed.push(event.tokens);
    expect(consumed).toEqual([99]);
  });

  it('merges every deferred patch at the attempt\'s end, also when a cancel ends it', async () => {
    const driver = new HangingDriver();
    const lane = laneOf(H.flow('f').input(Task.attributeSchema!).step('work', seatOf(), (ctx) => ({ title: ctx.unit.attributes.title })).exit('done'));
    const runtime = await started(H.harness('patches').ledger(ledger).lanes(lane).scheduler(H.scheduler('s').standard(lane)), driver);
    const unit = (await runtime.createUnit(lane, { title: 'p' }, { source: 'test' }))!;
    const walking = runtime.startAttempt(unit);
    while (driver.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    await runtime.deliverSignal('tasks', 'p', 'tag', { tag: 'a' }, 'test');
    await runtime.deliverSignal('tasks', 'p', 'tag', { tag: 'b' }, 'test');
    driver.release!();
    expect.soft(await walking).toEqual({ kind: 'exit', exit: 'done' });
    expect.soft((await runtime.find(unit))?.unit.attributes).toEqual({ title: 'p', tags: ['a', 'b'] });
    const second = (await runtime.createUnit(lane, { title: 'q' }, { source: 'test' }))!;
    const walking2 = runtime.startAttempt(second);
    while (driver.requests.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    await runtime.deliverSignal('tasks', 'q', 'tag', { tag: 'c' }, 'test');
    await runtime.cancelUnit(second, 'enough', 'test');
    await walking2;
    expect((await runtime.find(second))?.unit).toMatchObject({ state: 'Failed', attributes: { title: 'q', tags: ['c'] } });
  });

  it('sums an attempt\'s cost onto the unit, records no retry on exhaustion, and clears a stale resume timer', async () => {
    const driver = new ScriptedDriver((request) => {
      if ((request.input as { title: string }).title === 'bad') throw new Error('nope');
      return { output: { verdict: 'ok' }, costUsd: 1.25, tokens: 5 };
    });
    const flow = H.flow('f').input(Task.attributeSchema!).step('work', seatOf(), (ctx) => ({ title: ctx.unit.attributes.title })).wait('pause', { ms: 60_000 }).halt('approval', approval, { ask: () => 'ok?' }).exit('done');
    const lane = laneOf(flow);
    const runtime = await started(H.harness('cost').ledger(ledger).lanes(lane).scheduler(H.scheduler('s').standard(lane)).clients(fakeClient('owner', [H.ops.resolve(approval), H.ops.attempts.recover])), driver);
    const unit = (await runtime.createUnit(lane, { title: 'good' }, { source: 'test' }))!;
    expect.soft(await runtime.startAttempt(unit)).toMatchObject({ kind: 'blocked', on: 'timer' });
    await runtime.recover(unit, 'continue', 'owner');
    expect.soft((await runtime.find(unit))?.unit.attempt).toMatchObject({ status: 'blocked', halt: 'approval' });
    clock = minutes(2);
    await runtime.tick();
    const blocked = (await eventsOf(ledger, 'attemptBlocked')) as Event<'attemptBlocked'>[];
    expect.soft(blocked.map((event) => event.on)).toEqual(['timer', 'decision']);
    await runtime.resolveHalt(unit, { approved: true }, 'owner');
    expect.soft((await runtime.find(unit))?.unit.costUsd).toBe(1.25);
    const bad = (await runtime.createUnit(lane, { title: 'bad' }, { source: 'test' }))!;
    await runtime.startAttempt(bad);
    expect.soft((await runtime.find(bad))?.unit).toMatchObject({ state: 'Failed', position: 'terminal' });
    expect(await eventsOf(ledger, 'retryScheduled')).toEqual([]);
  });

  it('replays observers from the start of the ledger, serves clients after the replay, and keeps a stopped runtime from writing', async () => {
    const seen: string[] = [];
    const observer: Observer = { entity: 'observer', name: 'log', observe: async (entry: SequencedEvent) => void seen.push(entry.event.type) };
    const lane = laneOf(H.flow('f').input(Task.attributeSchema!).exit('done'));
    const harness = H.harness('observed').ledger(ledger).lanes(lane).scheduler(H.scheduler('s').standard(lane)).observers(observer);
    const first = await started(harness, new ScriptedDriver(() => ({ output: {}, costUsd: 0, tokens: 0 })), { claimTtlMs: 150 });
    await first.createUnit(lane, { title: 'one' }, { source: 'test' });
    await first.stop();
    runtimes.pop();
    await expect(first.append([{ type: 'lanePaused', lane: 'tasks', reason: 'late', by: 'test', at: T }])).rejects.toThrow(/stopped/);
    seen.length = 0;
    await started(harness, new ScriptedDriver(() => ({ output: {}, costUsd: 0, tokens: 0 })));
    expect(seen.slice(0, 2)).toEqual(['unitCreated', 'transition']);
  });

  it('a parallel branch that blocks lets its siblings finish once', async () => {
    let reviewerCalls = 0;
    const driver = new ScriptedDriver((request) => {
      if (request.seat === 'asker') return { output: null, costUsd: 0, tokens: 1, halt: { halt: 'approval', ask: 'go?' } };
      reviewerCalls += 1;
      return { output: { verdict: 'fine' }, costUsd: 0, tokens: 1 };
    });
    const asker = seatOf('asker');
    const reviewer = seatOf('reviewer');
    const flow = H.flow('f')
      .input(Task.attributeSchema!)
      .parallel('both', { ask: { exec: asker, input: (ctx) => ({ title: ctx.unit.attributes.title }) }, review: { exec: reviewer, input: (ctx) => ({ title: ctx.unit.attributes.title }) } })
      .exit('done');
    const lane = H.lane('tasks', Task).supply(H.operator).handler(flow, { exits: { done: Done } }).retry({ tries: 0, exhausted: Failed }).on(H.cancel, { enter: Failed });
    const runtime = await started(H.harness('par').ledger(ledger).lanes(lane).scheduler(H.scheduler('s').standard(lane)), driver);
    const unit = (await runtime.createUnit(lane, { title: 'p' }, { source: 'test' }))!;
    const outcome = await runtime.startAttempt(unit);
    expect.soft(outcome).toMatchObject({ kind: 'blocked', on: 'decision', step: 'both/ask' });
    expect.soft(reviewerCalls).toBe(1);
    const ended = (await eventsOf(ledger, 'stepEnded')) as Event<'stepEnded'>[];
    expect(ended.map((event) => event.step)).toEqual(['both/review']);
  });

  it('mirrors a lane with a creating store: the record is created first and takes the key, then follows every transition and patch', async () => {
    const calls: string[] = [];
    let created = 0;
    const store: Store<'todo' | 'done' | 'failed'> = {
      entity: 'store',
      name: 'tracker',
      creates: true,
      create: async (kind, state, attrs) => {
        created += 1;
        calls.push(`create:${kind}:${state}:${(attrs as { title: string }).title}`);
        return { key: `ext-${created}` };
      },
      load: async () => undefined,
      save: async (key, attrs) => void calls.push(`save:${key}:${JSON.stringify(attrs)}`),
      transition: async (key, state) => void calls.push(`transition:${key}:${state}`),
    };
    const lane = laneOf(H.flow('f').input(Task.attributeSchema!).exit('done')).store(store, { states: { Open: 'todo', Done: 'done', Failed: 'failed' } });
    const runtime = await started(H.harness('stores').ledger(ledger).lanes(lane).scheduler(H.scheduler('s').standard(lane)), new ScriptedDriver(() => ({ output: {}, costUsd: 0, tokens: 0 })));
    const unit = (await runtime.createUnit(lane, { title: 's' }, { source: 'test' }))!;
    expect.soft((await runtime.find(unit))?.unit.key).toBe('ext-1');
    expect.soft(await runtime.startAttempt(unit)).toEqual({ kind: 'exit', exit: 'done' });
    await runtime.updateAttributes(unit, { tags: ['x'] }, 'test');
    expect(calls).toEqual(['create:Task:todo:s', 'transition:ext-1:done', 'save:ext-1:{"title":"s","tags":["x"]}']);
  });

  it('a lane whose store cannot create accepts only keys the store holds', async () => {
    const store: Store<'todo' | 'done' | 'failed'> = {
      entity: 'store',
      name: 'tracker',
      creates: false,
      create: async () => ({ key: 'never' }),
      load: async (key) => (key === 'known' ? { state: 'todo', attributes: {} } : undefined),
      save: async () => undefined,
      transition: async () => undefined,
    };
    const lane = laneOf(H.flow('f').input(Task.attributeSchema!).exit('done')).store(store, { states: { Open: 'todo', Done: 'done', Failed: 'failed' } });
    const runtime = await started(H.harness('stores').ledger(ledger).lanes(lane).scheduler(H.scheduler('s').standard(lane)), new ScriptedDriver(() => ({ output: {}, costUsd: 0, tokens: 0 })));
    await expect(runtime.createUnit(lane, { title: 'unknown' }, { source: 'test' })).rejects.toThrow(/no record "unknown"/);
    const unit = (await runtime.createUnit(lane, { title: 'known' }, { source: 'test' }))!;
    expect((await runtime.find(unit))?.unit.key).toBe('known');
  });

  it('a lane lease is taken at the attempt\'s start, keeps a rival pending, and records how long the rival waited', async () => {
    const driver = new HangingDriver();
    const lane = laneOf(H.flow('f').input(Task.attributeSchema!).step('work', seatOf(), (ctx) => ({ title: ctx.unit.attributes.title })).exit('done')).lease(() => ({ resource: db, mode: 'exclusive' }));
    const runtime = await started(H.harness('leases').ledger(ledger).lanes(lane).scheduler(H.scheduler('s').standard(lane)), driver);
    const first = (await runtime.createUnit(lane, { title: 'one' }, { source: 'test' }))!;
    const second = (await runtime.createUnit(lane, { title: 'two' }, { source: 'test' }))!;
    const walking = runtime.startAttempt(first);
    while (driver.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    expect.soft(await runtime.startAttempt(second)).toBeUndefined();
    expect.soft((await runtime.find(second))?.unit.attempt).toBeUndefined();
    clock = minutes(1);
    driver.release!();
    expect.soft(await walking).toEqual({ kind: 'exit', exit: 'done' });
    const walking2 = runtime.startAttempt(second);
    while (driver.requests.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    driver.release!();
    expect.soft(await walking2).toEqual({ kind: 'exit', exit: 'done' });
    const taken = (await eventsOf(ledger, 'leaseTaken')) as Event<'leaseTaken'>[];
    expect.soft(taken.map((event) => [event.resource, event.mode, event.waitedMs])).toEqual([['db', 'exclusive', 0], ['db', 'exclusive', 60_000]]);
    expect((await eventsOf(ledger, 'leaseReleased')).map((event) => (event as Event<'leaseReleased'>).resource)).toEqual(['db', 'db']);
  });

  it('an order holds a unit behind its open predecessor, parks it when the predecessor fails, and frees it when the predecessor succeeds', async () => {
    const driver = new ScriptedDriver((request) => {
      if ((request.input as { title: string }).title === 'first') throw new Error('nope');
      return { output: { verdict: 'ok' }, costUsd: 0, tokens: 1 };
    });
    const seat = H.seat('worker').role(workerRole).model(model).pool(pool);
    const lane = H.lane('ordered', Ordered)
      .supply(H.operator)
      .handler(H.flow('f').input(Ordered.attributeSchema!).step('work', seat, (ctx) => ({ title: ctx.unit.attributes.title })).exit('done'), { exits: { done: Done } })
      .retry({ tries: 0, exhausted: Failed })
      .after({ key: (a) => a.after, onPredecessorFailed: Parked })
      .on(H.cancel, { enter: Failed });
    const runtime = await started(H.harness('order').ledger(ledger).lanes(lane).scheduler(H.scheduler('s').standard(lane)), driver);
    const ids: Record<string, string> = {};
    for (const [title, after] of [['first', undefined], ['second', 'first'], ['third', undefined], ['fourth', 'third']] as const) {
      ids[title] = (await runtime.createUnit(lane, { title, ...(after ? { after } : {}) }, { source: 'test' }))!;
    }
    await runtime.tick();
    const held = (await eventsOf(ledger, 'orderHeld')) as Event<'orderHeld'>[];
    expect.soft(held.map((event) => [event.unitId, event.predecessorKey])).toEqual([[ids.second, 'first'], [ids.fourth, 'third']]);
    expect.soft(runtime.heldUnits()).toEqual(new Set([ids.second, ids.fourth]));
    await runtime.tick();
    const states = Object.fromEntries(await Promise.all(Object.entries(ids).map(async ([title, id]) => [title, (await runtime.find(id))?.unit.state])));
    expect.soft(states).toEqual({ first: 'Failed', second: 'Parked', third: 'Done', fourth: 'Done' });
    expect((await eventsOf(ledger, 'orderHeld')).length).toBe(2);
  });

  it('the lane ceiling asks its halt once per attempt before the call that would cross it, and a decision lets the attempt go on', async () => {
    const driver = new ScriptedDriver(() => ({ output: { verdict: 'ok' }, costUsd: 1, tokens: 1 }));
    const flow = H.flow('f').input(Task.attributeSchema!).step('work', seatOf(), (ctx) => ({ title: ctx.unit.attributes.title })).step('more', seatOf('again'), (ctx) => ({ title: ctx.unit.attributes.title })).exit('done');
    const lane = laneOf(flow).ceiling({ maxUsd: 1, onExceed: budget });
    const runtime = await started(H.harness('ceiling').ledger(ledger).lanes(lane).scheduler(H.scheduler('s').standard(lane)).clients(fakeClient('owner', [H.ops.resolve(budget)])), driver);
    const unit = (await runtime.createUnit(lane, { title: 'c' }, { source: 'test' }))!;
    expect.soft(await runtime.startAttempt(unit)).toMatchObject({ kind: 'blocked', on: 'decision', step: 'more/ceiling', halt: budget, ask: expect.stringContaining('$1.00 of its $1.00 ceiling') });
    expect.soft(driver.requests).toHaveLength(1);
    await expect(runtime.decisionFor(unit, { proceed: 'yes' })).rejects.toThrow(/does not fit halt "budget"/);
    expect.soft(await runtime.resolveHalt(unit, await runtime.decisionFor(unit, { proceed: true }), 'owner')).toEqual({ kind: 'exit', exit: 'done' });
    expect.soft(driver.requests).toHaveLength(2);
    expect((await runtime.find(unit))?.unit.costUsd).toBe(2);
  });

  it('a step retries under its own policy with a timer, each try recorded, and fails the attempt when its tries run out', async () => {
    let calls = 0;
    const driver = new ScriptedDriver(() => {
      calls += 1;
      if (calls < 3) throw new Error(`flaky ${calls}`);
      return { output: { verdict: 'ok' }, costUsd: 0, tokens: 1 };
    });
    const flow = H.flow('f').input(Task.attributeSchema!).step('work', seatOf(), (ctx) => ({ title: ctx.unit.attributes.title }), { retry: { tries: 2, initialDelayMs: 1_000 } }).exit('done');
    const lane = laneOf(flow);
    const runtime = await started(H.harness('retry').ledger(ledger).lanes(lane).scheduler(H.scheduler('s').standard(lane)), driver);
    const unit = (await runtime.createUnit(lane, { title: 'r' }, { source: 'test' }))!;
    expect.soft(await runtime.startAttempt(unit)).toMatchObject({ kind: 'blocked', on: 'timer', step: 'work', detail: expect.stringContaining('retry 1 of 2'), resumeAt: new Date(T.getTime() + 1_000) });
    clock = new Date(T.getTime() + 1_500);
    await runtime.tick();
    expect.soft((await runtime.find(unit))?.unit.attempt).toMatchObject({ status: 'blocked', blockedOn: 'timer' });
    clock = new Date(T.getTime() + 3_000);
    await runtime.tick();
    expect.soft((await runtime.find(unit))?.unit).toMatchObject({ state: 'Done', position: 'terminal' });
    const ended = (await eventsOf(ledger, 'stepEnded')) as Event<'stepEnded'>[];
    expect.soft(ended.map((event) => event.ok)).toEqual([false, false, true]);
    expect.soft((await eventsOf(ledger, 'invocation')).map((event) => (event as Event<'invocation'>).ok)).toEqual([false, false, true]);
    const seqs: Record<string, number[]> = { timerFired: [], attemptResumed: [] };
    for await (const { seq, event } of ledger.read({ types: ['timerFired', 'attemptResumed'] })) seqs[event.type]!.push(seq);
    expect.soft(seqs.attemptResumed).toEqual(seqs.timerFired!.map((seq) => seq + 1));
    calls = 0;
    const once = laneOf(H.flow('f').input(Task.attributeSchema!).step('work', seatOf(), (ctx) => ({ title: ctx.unit.attributes.title }), { retry: { tries: 1 } }).exit('done'));
    await runtime.stop();
    runtimes.pop();
    const second = await started(H.harness('retry').ledger(ledger).lanes(once).scheduler(H.scheduler('s').standard(once)), driver);
    const bad = (await second.createUnit(once, { title: 'b' }, { source: 'test' }))!;
    expect.soft(await second.startAttempt(bad)).toMatchObject({ kind: 'blocked', on: 'timer', resumeAt: new Date(clock.getTime() + 60_000) });
    clock = new Date(clock.getTime() + 61_000);
    await second.tick();
    expect((await second.find(bad))?.unit).toMatchObject({ state: 'Failed', position: 'terminal' });
  });

  it('checks a signal payload against its schema, and a rewind during a running walk restarts the step', async () => {
    const driver = new HangingDriver();
    const lane = laneOf(H.flow('f').input(Task.attributeSchema!).step('work', seatOf(), (ctx) => ({ title: ctx.unit.attributes.title })).exit('done')).on(redo, { rewind: 'work' });
    const runtime = await started(H.harness('rewind').ledger(ledger).lanes(lane).scheduler(H.scheduler('s').standard(lane)), driver);
    expect(() => runtime.payloadFor('tasks', 'tag', { tag: 1 })).toThrow(ControlError);
    const unit = (await runtime.createUnit(lane, { title: 'w' }, { source: 'test' }))!;
    const walking = runtime.startAttempt(unit);
    while (driver.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    expect.soft(await runtime.deliverSignal('tasks', 'w', 'redo', {}, 'test')).toBe(true);
    expect.soft(await walking).toEqual({ kind: 'cancelled' });
    while (driver.requests.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    driver.release!();
    for (let waited = 0; (await runtime.find(unit))?.unit.position !== 'terminal' && waited < 200; waited += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect.soft((await runtime.find(unit))?.unit).toMatchObject({ state: 'Done', position: 'terminal' });
    expect.soft((await eventsOf(ledger, 'attemptRewound')).map((event) => (event as Event<'attemptRewound'>).superseded)).toEqual([[]]);
    expect.soft((await eventsOf(ledger, 'attemptInterrupted'))).toEqual([]);
    expect((await eventsOf(ledger, 'attemptEnded')).map((event) => (event as Event<'attemptEnded'>).outcome)).toEqual(['succeeded']);
  });

  it('a trigger consequence already on the ledger is not repeated after a restart', async () => {
    const childLane = H.lane('children', Child).handler(H.flow('c').input(Child.attributeSchema!).exit('done'), { exits: { done: ChildDone } }).retry({ tries: 0, exhausted: ChildDone }).on(H.cancel, { enter: ChildDone });
    const lane = laneOf(H.flow('f').input(Task.attributeSchema!).exit('done'));
    const audit = H.trigger('audit').on(H.when.transition(lane, { to: Done })).do((e, act) => act.create(childLane, { title: `audit:${e.unit.key}`, n: 1 }));
    const harness = H.harness('fired').ledger(ledger).lanes(lane, childLane).scheduler(H.scheduler('s').standard(lane, childLane)).triggers(audit);
    const driver = new ScriptedDriver(() => ({ output: {}, costUsd: 0, tokens: 0 }));
    const first = await started(harness, driver, { claimTtlMs: 150 });
    const unit = (await first.createUnit(lane, { title: 'm' }, { source: 'test' }))!;
    await first.pauseLane('tasks', 'hold', 'test');
    await first.tick();
    expect.soft(await eventsOf(ledger, 'triggersProcessed')).toHaveLength(1);
    expect.soft(await first.startAttempt(unit)).toEqual({ kind: 'exit', exit: 'done' });
    let doneSeq = 0;
    for await (const { seq, event } of ledger.read({ types: ['transition'] })) if (event.type === 'transition' && event.to === 'Done') doneSeq = seq;
    await first.append([{ type: 'triggerFired', trigger: 'audit', sourceSeq: doneSeq, consequence: 'create', targetId: 'children', result: 'applied', at: T }]);
    await first.stop();
    runtimes.pop();
    const second = await started(harness, driver);
    await second.tick();
    expect.soft((await ledger.units({ lane: 'children' })).map((record) => record.unit.key)).toEqual([]);
    expect.soft(await eventsOf(ledger, 'triggerFired')).toHaveLength(1);
    await second.resumeLane('tasks', 'go', 'test');
    await second.createUnit(lane, { title: 'n' }, { source: 'test' });
    await second.tick();
    expect.soft((await ledger.units({ lane: 'children' })).map((record) => record.unit.key)).toEqual(['audit:n:1']);
    expect(await eventsOf(ledger, 'triggerFired')).toHaveLength(2);
  });

  it('a fired trigger timer is not armed again at the same deadline when the unit is updated', async () => {
    const lane = laneOf(H.flow('f').input(Task.attributeSchema!).halt('ok', approval, { ask: () => 'ok?' }).exit('done'));
    const late = H.trigger('late').on(H.when.timer(lane, { at: () => minutes(60) })).do((e, act) => act.pause(lane, `late: ${e.unit.key}`));
    const harness = H.harness('timers').ledger(ledger).lanes(lane).scheduler(H.scheduler('s').standard(lane)).clients(fakeClient('owner', [H.ops.resolve(approval)])).triggers(late);
    const runtime = await started(harness, new ScriptedDriver(() => ({ output: {}, costUsd: 0, tokens: 0 })));
    const unit = (await runtime.createUnit(lane, { title: 't' }, { source: 'test' }))!;
    await runtime.tick();
    expect.soft((await runtime.find(unit))?.unit.attempt).toMatchObject({ status: 'blocked', blockedOn: 'decision' });
    expect.soft(await eventsOf(ledger, 'timerSet')).toHaveLength(1);
    clock = minutes(61);
    await runtime.tick();
    expect.soft(runtime.pausedLanes().has('tasks')).toBe(true);
    await runtime.updateAttributes(unit, { tags: ['x'] }, 'test');
    await runtime.tick();
    clock = minutes(120);
    await runtime.tick();
    const counts = await Promise.all((['timerSet', 'timerFired', 'lanePaused'] as const).map(async (type) => (await eventsOf(ledger, type)).length));
    expect(counts).toEqual([1, 1, 1]);
  });

  it('releases the workspace when the attempt ends and refuses to continue a command whose output it cannot fabricate', async () => {
    const released: string[] = [];
    const workspace = defineWorkspace('ws', { prepare: async (attemptId) => ({ path: path.join(dir, attemptId) }), release: async (attemptId) => void released.push(attemptId) });
    let powerOff = false;
    const runner: RunnerBackend = {
      exec: async (command) => {
        if (command.argv[0] === 'deploy') powerOff = true;
        return { exitCode: 0, stdout: '{"url":"x"}', stderr: '', durationMs: 1 };
      },
    };
    const cutting = () => {
      if (powerOff) throw new Error('power off');
      return clock;
    };
    const deploy = H.command('deploy').output(z.object({ url: z.string() })).argv(['deploy']).runner(defineRunner('local', runner)).effect('unrepeatable');
    const flow = H.flow('f').input(Task.attributeSchema!).step('work', seatOf(), (ctx) => ({ title: ctx.unit.attributes.title }), { workspace }).step('deploy', deploy).exit('done');
    const lane = laneOf(flow);
    const harness = H.harness('ws').ledger(ledger).lanes(lane).scheduler(H.scheduler('s').standard(lane)).clients(fakeClient('owner', [H.ops.attempts.recover]));
    const first = await started(harness, new ScriptedDriver(() => ({ output: { verdict: 'ok' }, costUsd: 0, tokens: 1 })), { claimTtlMs: 150, now: cutting });
    const unit = (await first.createUnit(lane, { title: 'w' }, { source: 'test' }))!;
    await expect(first.startAttempt(unit)).rejects.toThrow(/power off/);
    powerOff = false;
    await first.stop();
    runtimes.pop();
    const second = await started(harness, new ScriptedDriver(() => ({ output: { verdict: 'ok' }, costUsd: 0, tokens: 1 })));
    const attemptId = (await second.find(unit))?.unit.attempt?.id;
    expect.soft((await second.find(unit))?.unit.attempt).toMatchObject({ status: 'blocked', blockedOn: 'interrupted' });
    expect.soft(released).toEqual([]);
    expect.soft(await second.recover(unit, 'continue', 'owner')).toMatchObject({ kind: 'failed', error: expect.stringContaining('deploy') });
    expect.soft((await second.find(unit))?.unit).toMatchObject({ state: 'Failed', position: 'terminal' });
    expect(released).toEqual([attemptId]);
  });
});
