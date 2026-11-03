import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { H, validate, type CommandResult, type FlowDef, type HarnessDef, type Problem } from '../../src/dsl/index.js';
import type { ModelDriver } from '../../src/kernel/index.js';
import { Runtime, StartupError } from '../../src/engine/runtime.js';
import { fakeAccount, fakeClient, fakeLedger, fakeModel, fakeQuota, fakeRunner, fakeStore, fakeWorkspace } from './scenarios/doubles.js';

const Todo = H.state('Todo', 'pending');
const Parked = H.state('Parked', 'waiting');
const Done = H.terminal('Done', 'success');
const Failed = H.terminal('Failed', 'failure');
const attrs = z.object({ ref: z.string() });
const Bug = H.kind('Bug').attributes(attrs).states(Todo, Parked, Done, Failed).key((a) => a.ref).initial(Todo);
const quota = fakeQuota('q');
const account = fakeAccount('acct', 'claude-code', quota);
const api = fakeAccount('api', 'claude-code', quota);
const sonnet = fakeModel('sonnet', 'claude-code', 'id');
const batchModel = { ...fakeModel('big', 'claude-code', 'big-id'), batch: true as const };
const pool = H.pool('pool').accounts(account);
const role = H.role('builder').input(attrs).output(z.object({ ok: z.boolean() })).prompt(() => 'go');
const builder = H.seat('builder').role(role).model(sonnet).pool(pool);
const local = fakeRunner('local');
const approval = H.halt('approval').decision(z.object({ ok: z.boolean() }));
const checks = H.command('checks').argv(['checks']).runner(local);

function rules(harness: HarnessDef): number[] {
  return [...new Set(validate(harness).map((problem: Problem) => problem.rule))].sort((a, b) => a - b);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function laneOf(flow: FlowDef<any, any, any, 'done', any>) {
  return H.lane('bugs', Bug).handler(flow, { exits: { done: Done } }).retry({ tries: 0, exhausted: Failed });
}
function harnessOf(...lanes: readonly ReturnType<typeof laneOf>[]): HarnessDef {
  return H.harness('h').ledger(fakeLedger()).lanes(...lanes).scheduler(H.scheduler('s').standard(...lanes));
}

describe('descriptor chains keep what was set earlier', () => {
  it('a seat keeps its pool when the model comes later, and a pool keeps its fallback when the accounts come later', () => {
    const seat = H.seat('late').role(role).pool(pool).model(sonnet);
    expect.soft(seat.poolDef?.name).toBe('pool');
    const withFallback = H.pool('p').fallback(api).accounts(account);
    expect(withFallback.fallbackAccount?.name).toBe('api');
  });

  it('a halt policy takes a kind with states, and a batch takes its poll interval', () => {
    const skip = H.policy.halt('auto', Bug, approval).decide((ctx) => (ctx.unit.attributes.ref === 'x' ? { ok: true } : undefined));
    expect.soft(skip.kind.name).toBe('Bug');
    const grader = H.seat('grader').role(role).model(batchModel).pool(pool);
    expect.soft(H.batch('grade', grader).pollEveryMinutes).toBe(10);
    expect(H.batch('grade', grader, { pollEveryMinutes: 3 }).pollEveryMinutes).toBe(3);
  });

  it('parallel takes seats and commands with typed inputs and types their outputs, and a when or loop body does not widen the lane\'s step names', () => {
    const reviewer = H.seat('reviewer').role(H.role('r').input(z.object({ sha: z.string() })).output(z.object({ blocking: z.array(z.string()) }))).model(sonnet).pool(pool);
    const flow = H.flow('f')
      .input(attrs)
      .step('build', builder, (ctx) => ctx.unit.attributes)
      .parallel('records', { review: { exec: reviewer, input: (ctx) => ({ sha: ctx.steps.build.ok ? 'a' : 'b' }) }, checks })
      .loop('rounds', (round) => round.step('again', checks), { max: (ctx) => (ctx.unit.attributes.ref === 'x' ? 0 : 1) })
      .exit('done', (ctx) => ctx.steps.records.review.blocking.length === 0 && ctx.steps.again === undefined)
      .exit('fixed');
    expectTypeOf<NonNullable<typeof flow._types>['steps']['records']['review']>().toEqualTypeOf<{ blocking: string[] }>();
    expectTypeOf<NonNullable<typeof flow._types>['steps']['again']>().toEqualTypeOf<CommandResult | undefined>();
    // @ts-expect-error the step 'again' lives in the loop body and is not a top-level step a reaction can name
    H.lane('bugs', Bug).handler(flow, { exits: { done: Done, fixed: Done } }).on(H.cancel, { rewind: 'again' });
    // @ts-expect-error a branch input that does not fit the executable's input
    H.flow('g').input(attrs).parallel('records', { review: { exec: reviewer, input: () => ({ sha: 1 }) } });
    expect(validate(harnessOf(H.lane('bugs', Bug).handler(flow, { exits: { done: Done, fixed: Done } }).retry({ tries: 0, exhausted: Failed })))).toEqual([]);
  });
});

describe('validation rules the review found short', () => {
  it('1: two kinds, two halts or two states with one name, and two policies with one name', () => {
    const OtherBug = H.kind('Bug').attributes(attrs).states(Todo, Done).key((a) => a.ref).initial(Todo);
    const other = H.lane('other', OtherBug).handler(H.flow('o').input(attrs).exit('done'), { exits: { done: Done } }).retry({ tries: 0, exhausted: Done });
    expect.soft(rules(H.harness('h').ledger(fakeLedger()).lanes(laneOf(H.flow('f').input(attrs).exit('done')), other).scheduler(H.scheduler('s').standard(other)).scheduler(H.scheduler('s').standard(laneOf(H.flow('f').input(attrs).exit('done')), other)))).toContain(1);
    const twin = H.halt('approval').decision(z.object({ yes: z.boolean() }));
    const flow = H.flow('f').input(attrs).halt('a', approval, { ask: () => '?', timeout: { afterMinutes: 1, decide: () => ({ ok: true }) } }).halt('b', twin, { ask: () => '?', timeout: { afterMinutes: 1, decide: () => ({ yes: true }) } }).exit('done');
    expect.soft(rules(harnessOf(laneOf(flow)))).toContain(1);
    const Twice = H.kind('Twice').attributes(attrs).states(Todo, H.terminal('Done', 'success'), H.terminal('Done', 'failure')).key((a) => a.ref).initial(Todo);
    const twiceLane = H.lane('twice', Twice).handler(H.flow('t').input(attrs).exit('done'), { exits: { done: H.terminal('Done', 'success') } }).retry({ tries: 0, exhausted: H.terminal('Done', 'success') });
    expect.soft(rules(H.harness('h').ledger(fakeLedger()).lanes(twiceLane).scheduler(H.scheduler('s').standard(twiceLane)))).toContain(1);
    const drain1 = H.policy.account('drain', (ctx) => ctx.candidates[0]);
    const drain2 = H.policy.account('drain', (ctx) => ctx.candidates[1]);
    const seatA = H.seat('a').role(role).model(sonnet).pool(H.pool('pa').accounts(account).drain(drain1));
    const seatB = H.seat('b').role(role).model(sonnet).pool(H.pool('pb').accounts(account).drain(drain2));
    expect(rules(harnessOf(laneOf(H.flow('f').input(attrs).step('a', seatA, (ctx) => ctx.unit.attributes).step('b', seatB, (ctx) => ctx.unit.attributes).exit('done'))))).toContain(1);
  });

  it('2: a resource set named like a ledger column', () => {
    const Sets = H.resources('resource', ['a']);
    const flow = H.flow('f').input(attrs).step('build', builder, (ctx) => ctx.unit.attributes, { workspace: fakeWorkspace('w').withAreas(Sets, { a: ['a/**'] }), guard: { leases: Sets } }).exit('done');
    expect(rules(harnessOf(laneOf(flow)))).toContain(2);
  });

  it('7: a waiting exhaustion without reopenAfter, and a reopenAfter on a terminal state', () => {
    const waiting = H.lane('bugs', Bug).handler(H.flow('f').input(attrs).exit('done'), { exits: { done: Done } }).retry({ tries: 0, exhausted: Parked as unknown as typeof Failed });
    expect.soft(rules(harnessOf(waiting))).toContain(7);
    const reopened = H.lane('bugs', Bug).handler(H.flow('f').input(attrs).exit('done'), { exits: { done: Done } }).retry({ tries: 0, exhausted: { state: Failed as unknown as typeof Parked, reopenAfter: { hours: 1 } } });
    expect(rules(harnessOf(reopened))).toContain(7);
  });

  it('8: a harness with lanes and no scheduler, and an invocation source over an unregistered lane', () => {
    const lane = laneOf(H.flow('f').input(attrs).exit('done'));
    expect.soft(rules(H.harness('h').ledger(fakeLedger()).lanes(lane))).toContain(8);
    const stranger = H.lane('strangers', Bug).handler(H.flow('g').input(attrs).exit('done'), { exits: { done: Done } }).retry({ tries: 0, exhausted: Failed });
    const calls = H.metric('calls', H.when.invocation({ lanes: [stranger] })).amounts((e) => [{ amount: e.costUsd }]);
    expect(rules(harnessOf(lane).metrics(calls).triggers(H.trigger('t').on(H.when.invocation({ lanes: [stranger] })).do(() => [])))).toContain(8);
  });

  it('11 and 12: a batch seat without a pool', () => {
    const grader = H.seat('grader').role(role).model(batchModel);
    const flow = H.flow('f').input(attrs).step('grade', H.batch('grade', grader), (ctx) => [ctx.unit.attributes]).exit('done');
    expect(rules(harnessOf(laneOf(flow)))).toContain(11);
  });

  it('15: a ceiling halt is asked, and a halt a seat may raise needs a resolver', () => {
    const budget = H.halt('budget').decision(z.object({ go: z.boolean() }));
    const lane = H.lane('bugs', Bug).handler(H.flow('f').input(attrs).exit('done'), { exits: { done: Done } }).retry({ tries: 0, exhausted: Failed }).ceiling({ maxUsd: 5, onExceed: budget });
    expect.soft(rules(H.harness('h').ledger(fakeLedger()).lanes(lane).scheduler(H.scheduler('s').standard(lane)).clients(fakeClient('c', [H.ops.resolve(budget)])))).toEqual([]);
    expect.soft(rules(H.harness('h').ledger(fakeLedger()).lanes(lane).scheduler(H.scheduler('s').standard(lane)))).toContain(15);
    const raising = H.flow('f').input(attrs).step('build', builder, (ctx) => ctx.unit.attributes, { halts: [approval] }).exit('done');
    expect.soft(rules(harnessOf(laneOf(raising)))).toContain(15);
    expect(rules(harnessOf(laneOf(raising)).clients(fakeClient('c', [H.ops.resolve(approval)])))).toEqual([]);
  });

  it('16: a skip policy declared for another halt or kind', () => {
    const other = H.halt('other').decision(z.object({ ok: z.boolean() }));
    const wrongHalt = H.policy.halt('skip', Bug, other).decide(() => ({ ok: true }));
    const flow = H.flow('f').input(attrs).halt('approve', approval, { ask: () => '?', skip: wrongHalt as never }).exit('done');
    expect.soft(rules(harnessOf(laneOf(flow)))).toContain(16);
    const OtherKind = H.kind('Other').attributes(attrs).states(Todo, Done).key((a) => a.ref).initial(Todo);
    const wrongKind = H.policy.halt('skip', OtherKind, approval).decide(() => ({ ok: true }));
    const flow2 = H.flow('f').input(attrs).halt('approve', approval, { ask: () => '?', skip: wrongKind }).exit('done');
    expect(rules(harnessOf(laneOf(flow2)))).toContain(16);
  });

  it('19: a bare command as a stop check, an escalation or an operation', () => {
    const bare = H.command('bare');
    const guarded = H.flow('f').input(attrs).step('build', builder, (ctx) => ctx.unit.attributes, { workspace: fakeWorkspace('w'), guard: { beforeStop: bare } }).exit('done');
    expect.soft(rules(harnessOf(laneOf(guarded)))).toContain(19);
    const escalating = H.flow('f').input(attrs).halt('approve', approval, { ask: () => '?', timeout: { afterMinutes: 30, decide: () => ({ ok: true }) }, escalate: { afterMinutes: 10, run: bare } }).exit('done');
    expect.soft(rules(harnessOf(laneOf(escalating)))).toContain(19);
    expect(rules(harnessOf(laneOf(H.flow('f').input(attrs).exit('done'))).clients(fakeClient('c', [H.operation('probe', bare)])))).toContain(19);
  });

  it('20: a supplied lane whose store cannot create', () => {
    const store = { ...fakeStore('tracker', ['T', 'D'] as const), creates: false };
    const supplier = { entity: 'supplier' as const, name: 'feed', start: async () => ({ stop: async () => undefined }) };
    const lane = H.lane('bugs', Bug)
      .supply(supplier as never, (event: { ref: string }, to) => to.create(event))
      .handler(H.flow('f').input(attrs).exit('done'), { exits: { done: Done } })
      .store(store, { states: { Todo: 'T', Parked: 'T', Done: 'D', Failed: 'D' } })
      .retry({ tries: 0, exhausted: Failed });
    expect(rules(H.harness('h').ledger(fakeLedger()).lanes(lane).scheduler(H.scheduler('s').standard(lane)))).toContain(20);
  });

  it('4 and 22: a name used twice at the top level is rule 4; a when body reusing a sibling\'s name is rule 22', () => {
    const twice = H.flow('f').input(attrs).step('build', builder, (ctx) => ctx.unit.attributes).step('build', builder, (ctx) => ctx.unit.attributes).exit('done');
    expect.soft(rules(harnessOf(laneOf(twice)))).toContain(4);
    const shadowed = H.flow('f')
      .input(attrs)
      .step('build', builder, (ctx) => ctx.unit.attributes)
      .when('again', (ctx) => !ctx.steps.build.ok, (body) => body.step('build', builder, (ctx) => ctx.unit.attributes))
      .exit('done');
    expect(rules(harnessOf(laneOf(shadowed)))).toContain(22);
  });

  it('13: the runtime refuses a guarded step on a driver without hooks, and without a hook server', () => {
    const flow = H.flow('f').input(attrs).step('build', builder, (ctx) => ctx.unit.attributes, { workspace: fakeWorkspace('w'), guard: { beforeStop: checks } }).exit('done');
    const harness = harnessOf(laneOf(flow));
    const hookless: ModelDriver = { name: 'd', driver: 'claude-code', hooks: false, serves: () => true, invoke: async () => ({ output: {}, costUsd: 0, tokens: 0 }) };
    const hooked: ModelDriver = { ...hookless, hooks: true };
    const resolver = { env: () => '', port: () => 0 };
    expect.soft(() => new Runtime({ harness, drivers: [hookless], resolver, hooks: { port: 0 } })).toThrow(StartupError);
    expect.soft(() => new Runtime({ harness, drivers: [hooked], resolver })).toThrow(/\[13\]/);
    expect(() => new Runtime({ harness, drivers: [hooked], resolver, hooks: { port: 0 } })).not.toThrow();
  });
});
