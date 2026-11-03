import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import type { BatchModel, Model, RunnerBackend } from '../../src/kernel/index.js';
import type { Account, QuotaPartition } from '../../src/kernel/quota.js';
import { command } from '../../src/dsl/commands.js';
import { cancel, halt, signal } from '../../src/dsl/halts.js';
import { batch, job } from '../../src/dsl/jobs.js';
import { kind, state, terminal } from '../../src/dsl/kinds.js';
import { journal, memory } from '../../src/dsl/memory.js';
import { policy } from '../../src/dsl/policies.js';
import { pool } from '../../src/dsl/pools.js';
import { facet, resource, resources } from '../../src/dsl/resources.js';
import { role } from '../../src/dsl/roles.js';
import { defineRunner, defineWorkspace } from '../../src/dsl/runners.js';
import { seat } from '../../src/dsl/seats.js';

const quota: QuotaPartition = { name: 'q', join: async () => ({ accepted: true }), append: async () => undefined, read: async function* () {}, close: () => undefined };
const claudeAccount: Account<'claude-code'> = { entity: 'account', name: 'sub-a', driver: 'claude-code', credential: { ref: 'env', name: 'TOKEN' }, quota };
const anthropicAccount: Account<'anthropic'> = { entity: 'account', name: 'api', driver: 'anthropic', credential: { ref: 'env', name: 'KEY' }, quota };
const sonnet: Model<'claude-code'> = { entity: 'model', name: 'sonnet', id: 'claude-sonnet-5-5', driver: 'claude-code', batch: false };
const opus: Model<'claude-code'> = { entity: 'model', name: 'opus', id: 'claude-opus-5-5', driver: 'claude-code', batch: false };
const haikuBatch: BatchModel<'anthropic'> = { entity: 'model', name: 'haiku', id: 'claude-haiku-5-5', driver: 'anthropic', batch: true };
const backend: RunnerBackend = { exec: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 0 }) };

describe('kinds and states', () => {
  const Todo = state('Todo', 'pending');
  const Parked = state('Parked', 'waiting');
  const Done = terminal('Done', 'success');
  const Dropped = terminal('Dropped', 'neutral');
  const Bug = kind('Bug').attributes(z.object({ ref: z.string(), title: z.string() })).states(Todo, Parked, Done, Dropped).key((a) => a.ref).initial(Todo);

  it('types attributes, states and the initial state, and stays immutable', () => {
    expectTypeOf(Bug.keyOf!).parameter(0).toEqualTypeOf<{ ref: string; title: string }>();
    expectTypeOf(Bug.initialState).toEqualTypeOf<typeof Todo | undefined>();
    // @ts-expect-error a terminal state cannot be initial
    kind('X').states(Todo, Done).initial(Done);
    const renamed = Bug.key((a) => a.title);
    expect(renamed).not.toBe(Bug);
    expect(Bug.keyOf!({ ref: 'r', title: 't' })).toBe('r');
    expect(renamed.keyOf!({ ref: 'r', title: 't' })).toBe('t');
    expect(Done.verdict).toBe('success');
    expect(Parked.position).toBe('waiting');
    expect(Bug.stateList.map((s) => s.name)).toEqual(['Todo', 'Parked', 'Done', 'Dropped']);
  });
});

describe('halts, signals, resources, facets', () => {
  it('carries decision and payload types by identity', () => {
    const approval = halt('approval').decision(z.object({ approved: z.boolean() }));
    expectTypeOf<NonNullable<typeof approval._decision>>().toEqualTypeOf<{ approved: boolean }>();
    const redline = signal('redline').payload(z.object({ text: z.string() }));
    expectTypeOf<NonNullable<typeof redline._payload>>().toEqualTypeOf<{ text: string }>();
    expect(cancel.name).toBe('cancel');
    const Areas = resources('areas', ['edge', 'admin']);
    expect(Areas.of('edge')).toEqual({ entity: 'resource', name: 'areas:edge' });
    // @ts-expect-error not a member of the set
    Areas.of('web');
    const Category = facet('category', ['billing', 'refund']);
    expect(Category.of('billing')).toEqual({ facet: Category, value: 'billing' });
    expect(resource('orders-db').entity).toBe('resource');
  });
});

describe('roles, seats, pools', () => {
  const Reviewer = role('reviewer').input(z.object({ draft: z.string() })).output(z.object({ critique: z.string() })).prompt((i) => `Review ${i.draft}`).intents('read');
  const Subs = pool('subs').accounts(claudeAccount).fallback(claudeAccount);

  it('types the seat from the role and brands it by the model driver', () => {
    const reviewerA = seat('reviewer-a').role(Reviewer).model(sonnet).pool(Subs);
    expectTypeOf<NonNullable<typeof reviewerA._io>['out']>().toEqualTypeOf<{ critique: string }>();
    expectTypeOf<NonNullable<typeof reviewerA._seat>['driver']>().toEqualTypeOf<'claude-code'>();
    const Api = pool('api').accounts(anthropicAccount);
    // @ts-expect-error a pool of another driver cannot serve this model
    seat('bad').role(Reviewer).model(sonnet).pool(Api);
    expect(reviewerA.poolDef).toBe(Subs);
    expect(Reviewer.render!({ draft: 'd' })).toBe('Review d');
    expect(Reviewer.intentList).toEqual(['read']);
  });

  it('accepts a model policy with distinct seats and marks batch-capable seats', () => {
    const cheapUntilProven = policy.model('cheap-until-proven', [sonnet, opus], (ctx) => (ctx.metrics.attempts({ of: ctx.kind, seat: ctx.seat, model: sonnet }).successRate < 0.85 ? opus : sonnet), { distinct: true });
    const builder = seat('builder').role(Reviewer).model(cheapUntilProven).pool(Subs);
    expect(builder.modelChoice).toBe(cheapUntilProven);
    expect(cheapUntilProven.distinct).toBe(true);
    const extractor = seat('extractor').role(Reviewer).model(haikuBatch).pool(pool('api').accounts(anthropicAccount));
    const extractBatch = batch('extract', extractor);
    expectTypeOf<NonNullable<typeof extractBatch._io>['in']>().parameter(0).toEqualTypeOf<readonly { draft: string }[]>();
    // @ts-expect-error a seat on a non-batch model cannot be batched
    batch('bad', builder);
  });
});

describe('commands and jobs', () => {
  const local = defineRunner('local', backend).slots(3);

  it('types input and output, requires detect for external effects, and defaults the accepted exit codes', () => {
    const deploy = command('deploy').input(z.object({ sha: z.string() })).argv((i) => ['deploy', i.sha]).runner(local).effect('external', async ({ input, exec }) => (await exec(['deployed-sha'])).stdout.trim() === input.sha);
    expectTypeOf<NonNullable<typeof deploy._io>['in']>().parameter(0).toEqualTypeOf<{ sha: string }>();
    expect(deploy.effectKind).toBe('external');
    expect(deploy.detect).toBeTypeOf('function');
    // @ts-expect-error external needs detect
    command('x').effect('external');
    const probe = command('probe').acceptExitCodes(0, 1);
    expect(probe.acceptedExitCodes).toEqual([0, 1]);
    expect(command('plain').acceptedExitCodes).toEqual([0]);
    expect(command('plain').effectKind).toBe('repeatable');
    const typed = command('count').output(z.object({ rows: z.number() }));
    expectTypeOf<NonNullable<typeof typed._io>['out']>().toEqualTypeOf<{ rows: number }>();
    const chosen = command('scan').runner(policy.runner('free-disk', [local], (ctx) => ctx.candidates[0]!));
    expect(chosen.runnerChoice).toMatchObject({ policy: 'runner' });
  });

  it('builds a job from submit and collect executables', () => {
    const submit = command('submit').input(z.object({ checkpoint: z.string() })).output(z.object({ jobId: z.string() }));
    const collect = command('collect').input(z.object({ jobId: z.string() })).output(z.object({ state: z.literal('running') }).or(z.object({ state: z.literal('succeeded'), result: z.object({ score: z.number() }) })).or(z.object({ state: z.literal('failed'), reason: z.string() })));
    const evalJob = job('eval', { submit, collect, pollEveryMinutes: 10 });
    expectTypeOf<NonNullable<typeof evalJob._io>['out']>().toEqualTypeOf<{ score: number }>();
    expect(evalJob.pollEveryMinutes).toBe(10);
  });
});

describe('memory and workspaces', () => {
  it('builds journals immutably and maps workspace areas to a resource set', () => {
    const experience = memory('engineering', 'experience');
    const Reader = role('reader');
    const j = journal('exp', experience).readBy(Reader);
    const j2 = j.recordedBy(Reader);
    expect(j.recorders).toEqual([]);
    expect(j2.recorders).toEqual([Reader]);
    const Areas = resources('areas', ['edge', 'admin']);
    const wt = defineWorkspace('wt', { prepare: async () => ({ path: '/tmp' }), release: async () => undefined }).withAreas(Areas, { edge: ['apps/edge/**'], admin: ['apps/admin/**'] });
    expect(wt.areas).toEqual({ 'areas:edge': ['apps/edge/**'], 'areas:admin': ['apps/admin/**'] });
  });
});
