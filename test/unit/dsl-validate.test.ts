import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { H, validate, type HarnessDef, type Problem } from '../../src/dsl/index.js';
import { fakeAccount, fakeClient, fakeLedger, fakeModel, fakeQuota, fakeRunner, fakeStore, fakeWorkspace } from './scenarios/doubles.js';

const Todo = H.state('Todo', 'pending');
const Parked = H.state('Parked', 'waiting');
const Done = H.terminal('Done', 'success');
const Failed = H.terminal('Failed', 'failure');
const attrs = z.object({ ref: z.string() });
const Bug = H.kind('Bug').attributes(attrs).states(Todo, Parked, Done, Failed).key((a) => a.ref).initial(Todo);
const quota = fakeQuota('q');
const account = fakeAccount('acct', 'claude-code', quota);
const otherAccount = fakeAccount('other', 'anthropic', quota);
const sonnet = fakeModel('sonnet', 'claude-code', 'id');
const pool = H.pool('pool').accounts(account);
const role = H.role('builder').input(attrs).output(z.object({ ok: z.boolean() })).prompt(() => 'go');
const builder = H.seat('builder').role(role).model(sonnet).pool(pool);
const local = fakeRunner('local');
const approval = H.halt('approval').decision(z.object({ ok: z.boolean() }));

const okFlow = H.flow('ok').input(attrs).step('build', builder, (ctx) => ctx.unit.attributes).exit('done');
const okLane = H.lane('bugs', Bug).handler(okFlow, { exits: { done: Done } }).retry({ tries: 1, exhausted: Failed });
const base = H.harness('h').ledger(fakeLedger()).lanes(okLane).scheduler(H.scheduler('s').standard(okLane));

function rules(harness: HarnessDef): number[] {
  return [...new Set(validate(harness).map((problem: Problem) => problem.rule))].sort((a, b) => a - b);
}

describe('startup validation', () => {
  it('passes a minimal correct harness', () => {
    expect(validate(base)).toEqual([]);
  });

  it('1: two lanes with one name', () => {
    const twin = H.lane('bugs', Bug).handler(okFlow, { exits: { done: Done } }).retry({ tries: 1, exhausted: Failed });
    expect(rules(base.lanes(twin).scheduler(H.scheduler('s').standard(okLane, twin)))).toContain(1);
  });

  it('3: an exit the lane does not map, and a lane without a handler', () => {
    const two = H.flow('two').input(attrs).exit('a', () => true).exit('b');
    const lane = H.lane('bugs', Bug).handler(two, { exits: { a: Done } as unknown as { a: typeof Done; b: typeof Failed } }).retry({ tries: 0, exhausted: Failed });
    expect(rules(H.harness('h').ledger(fakeLedger()).lanes(lane).scheduler(H.scheduler('s').standard(lane)))).toContain(3);
    expect(rules(H.harness('h').ledger(fakeLedger()).lanes(H.lane('bugs', Bug)))).toContain(3);
  });

  it('4: a flow that does not end with an unconditional exit', () => {
    const open = H.flow('open').input(attrs).exit('done', () => true);
    const lane = H.lane('bugs', Bug).handler(open, { exits: { done: Done } }).retry({ tries: 0, exhausted: Failed });
    expect(rules(H.harness('h').ledger(fakeLedger()).lanes(lane).scheduler(H.scheduler('s').standard(lane)))).toContain(4);
  });

  it('5: a kind without an initial state', () => {
    const NoInitial = H.kind('Bug').attributes(attrs).states(Todo, Done);
    const lane = H.lane('bugs', NoInitial).handler(okFlow, { exits: { done: Done } }).retry({ tries: 0, exhausted: Done });
    expect(rules(H.harness('h').ledger(fakeLedger()).lanes(lane).scheduler(H.scheduler('s').standard(lane)))).toContain(5);
  });

  it('6: a store map that misses a state', () => {
    const store = fakeStore('tracker', ['T', 'D'] as const);
    const lane = okLane.store(store, { states: { Todo: 'T', Done: 'D' } as unknown as { Todo: 'T'; Parked: 'T'; Done: 'D'; Failed: 'D' } });
    expect(rules(H.harness('h').ledger(fakeLedger()).lanes(lane).scheduler(H.scheduler('s').standard(lane)))).toContain(6);
  });

  it('8: a lane in no scheduler class, and a spawn into an unregistered lane', () => {
    expect(rules(H.harness('h').ledger(fakeLedger()).lanes(okLane).scheduler(H.scheduler('s')))).toContain(8);
    const children = H.lane('children', Bug).handler(okFlow, { exits: { done: Done } }).retry({ tries: 0, exhausted: Failed });
    const spawning = H.flow('spawning').input(attrs).spawn('kids', children, () => []).exit('done');
    const parent = H.lane('parents', Bug).handler(spawning, { exits: { done: Done } }).retry({ tries: 0, exhausted: Failed });
    expect(rules(H.harness('h').ledger(fakeLedger()).lanes(parent).scheduler(H.scheduler('s').standard(parent)))).toContain(8);
  });

  it('9: a cancel grant without a cancel reaction', () => {
    const client = fakeClient('c', [H.ops.work.cancel]);
    expect(rules(base.clients(client))).toContain(9);
    const reacting = okLane.on(H.cancel, { enter: Failed });
    expect(rules(H.harness('h').ledger(fakeLedger()).lanes(reacting).scheduler(H.scheduler('s').standard(reacting)).clients(client))).toEqual([]);
  });

  it('10: a reaction naming a step the flow lacks, and a rewind target after its gate', () => {
    const redline = H.signal('redline').payload(z.object({ text: z.string() }));
    const two = H.flow('two').input(attrs).step('draft', builder, (ctx) => ctx.unit.attributes).step('review', builder, (ctx) => ctx.unit.attributes).exit('done');
    const bad = H.lane('bugs', Bug).handler(two, { exits: { done: Done } }).retry({ tries: 0, exhausted: Failed }).on(redline, { rewind: 'review', at: ['draft'] });
    expect(rules(H.harness('h').ledger(fakeLedger()).lanes(bad).scheduler(H.scheduler('s').standard(bad)))).toContain(10);
    const good = H.lane('bugs', Bug).handler(two, { exits: { done: Done } }).retry({ tries: 0, exhausted: Failed }).on(redline, { rewind: 'draft', at: ['review'] });
    expect(rules(H.harness('h').ledger(fakeLedger()).lanes(good).scheduler(H.scheduler('s').standard(good)))).toEqual([]);
  });

  it('11: a seat without a pool, a seat whose pool cannot serve its model, and seat options on a command', () => {
    const noPool = H.seat('lonely').role(role).model(sonnet);
    const flow = H.flow('f').input(attrs).step('build', noPool, (ctx) => ctx.unit.attributes).exit('done');
    const lane = H.lane('bugs', Bug).handler(flow, { exits: { done: Done } }).retry({ tries: 0, exhausted: Failed });
    expect(rules(H.harness('h').ledger(fakeLedger()).lanes(lane).scheduler(H.scheduler('s').standard(lane)))).toContain(11);
    const wrongPool = H.seat('wrong').role(role).model(sonnet).pool(H.pool('api').accounts(otherAccount) as unknown as typeof pool);
    const flow2 = H.flow('f').input(attrs).step('build', wrongPool, (ctx) => ctx.unit.attributes).exit('done');
    const lane2 = H.lane('bugs', Bug).handler(flow2, { exits: { done: Done } }).retry({ tries: 0, exhausted: Failed });
    expect(rules(H.harness('h').ledger(fakeLedger()).lanes(lane2).scheduler(H.scheduler('s').standard(lane2)))).toContain(11);
    const cmd = H.command('c').argv(['x']).runner(local);
    const flow3 = H.flow('f').input(attrs).step('run', cmd, { workspace: fakeWorkspace('w') }).exit('done');
    const lane3 = H.lane('bugs', Bug).handler(flow3, { exits: { done: Done } }).retry({ tries: 0, exhausted: Failed });
    expect(rules(H.harness('h').ledger(fakeLedger()).lanes(lane3).scheduler(H.scheduler('s').standard(lane3)))).toContain(11);
  });

  it('12: a distinct policy shared by more seats than it has candidates', () => {
    const shared = H.policy.model('shared', [sonnet], () => sonnet, { distinct: true });
    const a = H.seat('a').role(role).model(shared).pool(pool);
    const b = H.seat('b').role(role).model(shared).pool(pool);
    const flow = H.flow('f').input(attrs).step('a', a, (ctx) => ctx.unit.attributes).step('b', b, (ctx) => ctx.unit.attributes).exit('done');
    const lane = H.lane('bugs', Bug).handler(flow, { exits: { done: Done } }).retry({ tries: 0, exhausted: Failed });
    expect(rules(H.harness('h').ledger(fakeLedger()).lanes(lane).scheduler(H.scheduler('s').standard(lane)))).toContain(12);
  });

  it('14: a guard leasing a set the workspace maps no areas for', () => {
    const Areas = H.resources('areas', ['edge']);
    const flow = H.flow('f').input(attrs).step('build', builder, (ctx) => ctx.unit.attributes, { workspace: fakeWorkspace('w'), guard: { leases: Areas } }).exit('done');
    const lane = H.lane('bugs', Bug).handler(flow, { exits: { done: Done } }).retry({ tries: 0, exhausted: Failed });
    expect(rules(H.harness('h').ledger(fakeLedger()).lanes(lane).scheduler(H.scheduler('s').standard(lane)))).toContain(14);
  });

  it('15: a halt nobody can resolve, and a grant for a halt nobody asks', () => {
    const flow = H.flow('f').input(attrs).halt('approve', approval, { ask: () => 'ok?' }).exit('done');
    const lane = H.lane('bugs', Bug).handler(flow, { exits: { done: Done } }).retry({ tries: 0, exhausted: Failed });
    const h = H.harness('h').ledger(fakeLedger()).lanes(lane).scheduler(H.scheduler('s').standard(lane));
    expect(rules(h)).toContain(15);
    expect(rules(h.clients(fakeClient('c', [H.ops.resolve(approval)])))).toEqual([]);
    expect(rules(base.clients(fakeClient('c', [H.ops.resolve(approval)])))).toContain(15);
    const timed = H.flow('f').input(attrs).halt('approve', approval, { ask: () => 'ok?', timeout: { afterMinutes: 30, decide: () => ({ ok: true }) } }).exit('done');
    const timedLane = H.lane('bugs', Bug).handler(timed, { exits: { done: Done } }).retry({ tries: 0, exhausted: Failed });
    expect(rules(H.harness('h').ledger(fakeLedger()).lanes(timedLane).scheduler(H.scheduler('s').standard(timedLane)))).toEqual([]);
  });

  it('16: a timeout not later than its escalation', () => {
    const page = H.command('page').argv(['page']).runner(local);
    const flow = H.flow('f').input(attrs).halt('approve', approval, { ask: () => 'ok?', timeout: { afterMinutes: 10, decide: () => ({ ok: true }) }, escalate: { afterMinutes: 20, run: page } }).exit('done');
    const lane = H.lane('bugs', Bug).handler(flow, { exits: { done: Done } }).retry({ tries: 0, exhausted: Failed });
    expect(rules(H.harness('h').ledger(fakeLedger()).lanes(lane).scheduler(H.scheduler('s').standard(lane)))).toContain(16);
  });

  it('17: a metric read that the harness does not register', () => {
    const approvals = H.metric('approvals', H.when.decision(Bug, approval)).samples((e) => [{ hit: e.decision.ok }]);
    const flow = H.flow('f').input(attrs).read('rate', approvals).exit('done');
    const lane = H.lane('bugs', Bug).handler(flow, { exits: { done: Done } }).retry({ tries: 0, exhausted: Failed });
    expect(rules(H.harness('h').ledger(fakeLedger()).lanes(lane).scheduler(H.scheduler('s').standard(lane)))).toContain(17);
    expect(rules(H.harness('h').ledger(fakeLedger()).lanes(lane).scheduler(H.scheduler('s').standard(lane)).metrics(approvals))).toEqual([]);
  });

  it('18: a share outside (0, 1]', () => {
    expect(rules(base.share(account, 1.5))).toContain(18);
    expect(rules(base.share(account, 0.5))).toEqual([]);
  });

  it('19: a command without argv or runner', () => {
    const bare = H.command('bare');
    const flow = H.flow('f').input(attrs).step('run', bare).exit('done');
    const lane = H.lane('bugs', Bug).handler(flow, { exits: { done: Done } }).retry({ tries: 0, exhausted: Failed });
    expect(rules(H.harness('h').ledger(fakeLedger()).lanes(lane).scheduler(H.scheduler('s').standard(lane)))).toContain(19);
    const external = H.command('deploy').argv(['deploy']).runner(local).output(z.object({ url: z.string() })).effect('external', async () => true);
    const flow2 = H.flow('f').input(attrs).step('run', external).exit('done');
    const lane2 = H.lane('bugs', Bug).handler(flow2, { exits: { done: Done } }).retry({ tries: 0, exhausted: Failed });
    expect(rules(H.harness('h').ledger(fakeLedger()).lanes(lane2).scheduler(H.scheduler('s').standard(lane2)))).toContain(19);
  });

  it('21 and 22: a unit-span loop inside a loop, and a name used twice', () => {
    const nested = H.flow('f')
      .input(attrs)
      .loop('outer', (outer) => outer.loop('inner', (inner) => inner.step('build', builder, (ctx) => ctx.unit.attributes), { max: 2, span: 'unit' }), { max: 2 })
      .exit('done');
    const lane = H.lane('bugs', Bug).handler(nested, { exits: { done: Done } }).retry({ tries: 0, exhausted: Failed });
    expect(rules(H.harness('h').ledger(fakeLedger()).lanes(lane).scheduler(H.scheduler('s').standard(lane)))).toContain(21);
    const twice = H.flow('f').input(attrs).step('build', builder, (ctx) => ctx.unit.attributes).step('build', builder, (ctx) => ctx.unit.attributes).exit('done');
    const lane2 = H.lane('bugs', Bug).handler(twice, { exits: { done: Done } }).retry({ tries: 0, exhausted: Failed });
    expect(rules(H.harness('h').ledger(fakeLedger()).lanes(lane2).scheduler(H.scheduler('s').standard(lane2)))).toContain(22);
  });
});
