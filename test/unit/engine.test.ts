import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SqliteLedger } from '../../src/adapters/sqlite/ledger.js';
import { H, type HarnessDef } from '../../src/dsl/index.js';
import { Runtime } from '../../src/engine/runtime.js';
import type { LedgerEvent, Metrics, ModelDriver, ModelRequest, ModelResponse, Resolver, RunnerBackend } from '../../src/kernel/index.js';
import { fakeAccount, fakeClient, fakeModel, fakeQuota } from './scenarios/doubles.js';
import { defineRunner } from '../../src/dsl/index.js';

class PowerOff extends Error {}

class ScriptedRunner implements RunnerBackend {
  public readonly calls: string[] = [];
  public readonly crashOnce = new Set<string>();
  public constructor(private readonly scripts: Record<string, (argv: readonly string[]) => { exitCode: number; stdout: string }>) {}
  public async exec(command: { readonly argv: readonly string[] }) {
    const name = command.argv[0]!;
    this.calls.push(name);
    if (this.crashOnce.has(name)) {
      this.crashOnce.delete(name);
      throw new PowerOff(`power off during ${name}`);
    }
    const script = this.scripts[name];
    if (!script) return { exitCode: 127, stdout: '', stderr: `no script ${name}`, durationMs: 1 };
    return { ...script(command.argv), stderr: '', durationMs: 1 };
  }
}

class ScriptedDriver implements ModelDriver<'test'> {
  public readonly name = 'test-driver';
  public readonly driver = 'test' as const;
  public readonly hooks = true;
  public readonly requests: ModelRequest[] = [];
  public readonly crashOnce = new Set<string>();
  public readonly finished = new Map<string, ModelResponse>();
  public constructor(private readonly respond: (request: ModelRequest) => ModelResponse) {}
  public serves() {
    return true;
  }
  public async invoke(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    if (this.crashOnce.has(request.seat)) {
      this.crashOnce.delete(request.seat);
      this.finished.set(request.idempotencyKey, this.respond(request));
      throw new PowerOff(`power off during ${request.seat}`);
    }
    return this.respond(request);
  }
  public async session(key: string) {
    const response = this.finished.get(key);
    return response ? ({ status: 'finished', response } as const) : ({ status: 'lost' } as const);
  }
}

const resolver: Resolver = { env: (ref) => ref.name, port: () => 0 };
const metrics: Metrics = {
  outcomes: () => ({ terminal: 0, success: 0, failure: 0, neutral: 0, successRate: 0, samples: 0, count: () => 0 }),
  attempts: () => ({ succeeded: 0, failed: 0, cancelled: 0, retried: 0, successRate: 0, samples: 0 }),
  rate: () => ({ rate: 0, hits: 0, samples: 0 }),
  total: () => ({ total: 0, samples: 0 }),
  paused: () => ({ totalMs: 0, count: 0 }),
  decisions: () => ({ samples: 0, medianMs: 0, byResolver: [] }),
  leases: () => ({ samples: 0, medianWaitMs: 0, totalWaitMs: 0 }),
  jobs: () => ({ hoursInFlight: 0, inFlightNow: 0, samples: 0 }),
};

const Requested = H.state('Requested', 'pending');
const Held = H.state('Held', 'waiting');
const Released = H.terminal('Released', 'success');
const Rejected = H.terminal('Rejected', 'failure');
const ReleaseFailed = H.terminal('ReleaseFailed', 'failure');
const SmokePending = H.state('SmokePending', 'pending');
const Passed = H.terminal('Passed', 'success');
const release = z.object({ sha: z.string(), platforms: z.array(z.string()), note: z.string().optional() });
const Release = H.kind('Release').attributes(release).states(Requested, Held, Released, Rejected, ReleaseFailed).key((a) => a.sha).initial(Requested);
const Smoke = H.kind('Smoke').attributes(z.object({ sha: z.string(), platform: z.string() })).states(SmokePending, Passed).key((a) => `${a.sha}:${a.platform}`).initial(SmokePending);

const quota = fakeQuota('q');
const account = fakeAccount('acct', 'test', quota);
const model = fakeModel('m', 'test', 'test-model');
const pool = H.pool('pool').accounts(account);
const reviewerRole = H.role('reviewer').input(z.object({ sha: z.string() })).output(z.object({ verdict: z.string() })).prompt((i) => `review ${i.sha}`);
const reviewer = H.seat('reviewer').role(reviewerRole).model(model).pool(pool);
const approval = H.halt('approval').decision(z.object({ approved: z.boolean() }));

function releaseHarness(runner: ScriptedRunner, ledger: SqliteLedger, options?: { readonly extraStep?: boolean }): HarnessDef {
  const local = defineRunner('local', runner);
  const build = H.command('build').input(z.object({ sha: z.string() })).argv((i) => ['build', i.sha]).runner(local).effect('repeatable');
  const announce = H.command('announce').input(z.object({ sha: z.string() })).argv((i) => ['announce', i.sha]).runner(local).effect('unrepeatable');
  const submit = H.command('submit').input(z.object({ sha: z.string() })).output(z.object({ jobId: z.string() })).argv((i) => ['submit', i.sha]).runner(local);
  const collect = H.command('collect').input(z.object({ jobId: z.string() })).output(z.object({ state: z.literal('running') }).or(z.object({ state: z.literal('succeeded'), result: z.object({ summary: z.string() }) }))).argv((i) => ['collect', i.jobId]).runner(local);
  const summarize = H.job('summarize', { submit, collect, pollEveryMinutes: 10 });
  const probe = H.command('probe').input(z.object({ platform: z.string() })).argv((i) => ['probe', i.platform]).runner(local);
  const smokeFlow = H.flow('smoke').input(z.object({ sha: z.string(), platform: z.string() })).step('probe', probe, (ctx) => ({ platform: ctx.unit.attributes.platform })).exit('passed');
  const smokeLane = H.lane('smoke', Smoke).handler(smokeFlow, { exits: { passed: Passed } }).retry({ tries: 0, exhausted: Passed }).on(H.cancel, { enter: Passed });
  const buildStep: 'build' | 'compile' = options?.extraStep ? 'compile' : 'build';
  const releaseFlow = H.flow('release')
    .input(release)
    .step(buildStep, build, (ctx) => ({ sha: ctx.unit.attributes.sha }))
    .step('announce', announce, (ctx) => ({ sha: ctx.unit.attributes.sha }))
    .step('review', reviewer, (ctx) => ({ sha: ctx.unit.attributes.sha }))
    .halt('approval', approval, { ask: (ctx) => `release ${ctx.unit.attributes.sha}?` })
    .exit('rejected', (ctx) => !ctx.steps.approval.approved)
    .step('summarize', summarize, (ctx) => ({ sha: ctx.unit.attributes.sha }))
    .spawn('smoke', smokeLane, (ctx) => ctx.unit.attributes.platforms.map((platform) => ({ sha: ctx.unit.attributes.sha, platform })))
    .exit('released');
  const releaseLane = H.lane('releases', Release)
    .supply(H.operator)
    .handler(releaseFlow, { exits: { released: Released, rejected: Rejected } })
    .retry({ tries: 0, exhausted: ReleaseFailed })
    .on(H.cancel, { enter: Rejected });
  return H.harness('release-harness')
    .ledger(ledger)
    .lanes(releaseLane, smokeLane)
    .scheduler(H.scheduler('s').standard(releaseLane, smokeLane))
    .clients(fakeClient('manager', [H.ops.resolve(approval), H.ops.attempts.recover]));
}

describe('the engine over the ledger', () => {
  let dir: string;
  let ledger: SqliteLedger;
  let runner: ScriptedRunner;
  let driver: ScriptedDriver;
  let clock: Date;
  const now = () => clock;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'harness-engine-'));
    ledger = new SqliteLedger({ path: path.join(dir, 'ledger.sqlite') });
    clock = new Date('2026-11-02T12:00:00Z');
    runner = new ScriptedRunner({
      build: () => ({ exitCode: 0, stdout: 'built' }),
      announce: () => ({ exitCode: 0, stdout: 'posted' }),
      submit: () => ({ exitCode: 0, stdout: JSON.stringify({ jobId: 'job-1' }) }),
      collect: () => ({ exitCode: 0, stdout: JSON.stringify(clock.getTime() >= Date.parse('2026-11-02T12:30:00Z') ? { state: 'succeeded', result: { summary: 'ok' } } : { state: 'running' }) }),
      probe: () => ({ exitCode: 0, stdout: 'alive' }),
    });
    driver = new ScriptedDriver(() => ({ output: { verdict: 'looks good' }, costUsd: 0.01, tokens: 10, sessionId: 'session-1' }));
  });

  afterEach(() => {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function runtime(holder: string, options?: { readonly extraStep?: boolean; readonly ttl?: number }): Runtime {
    return new Runtime({ harness: releaseHarness(runner, ledger, options), drivers: [driver], resolver, metrics, now, holder, claimTtlMs: options?.ttl ?? 60_000 });
  }

  async function events(filter?: Partial<Record<LedgerEvent['type'], true>>): Promise<LedgerEvent[]> {
    const out: LedgerEvent[] = [];
    for await (const { event } of ledger.read({})) if (!filter || filter[event.type]) out.push(event);
    return out;
  }

  async function startRelease(rt: Runtime): Promise<string> {
    const unitId = (await rt.createUnit(rt.lane('releases'), { sha: 'abc', platforms: ['mac', 'linux'] }, { source: 'operator' }))!;
    return unitId;
  }

  it('runs the release to the approval halt, resolves it, collects the job, sees its children and exits with the same attempt', async () => {
    const rt = runtime('a');
    await rt.start();
    const unitId = await startRelease(rt);
    const blocked = await rt.startAttempt(unitId);
    expect(blocked).toMatchObject({ kind: 'blocked', step: 'approval', on: 'decision', ask: 'release abc?' });
    const attemptId = (await rt.record(unitId)).unit.attempt!.id;
    expect(runner.calls).toEqual(['build', 'announce']);
    expect(driver.requests).toHaveLength(1);

    const afterApproval = await rt.resolveHalt(unitId, { approved: true }, 'manager');
    expect(afterApproval).toMatchObject({ kind: 'blocked', step: 'summarize', on: 'job' });
    expect(runner.calls).toEqual(['build', 'announce', 'submit']);

    clock = new Date('2026-11-02T12:10:00Z');
    await rt.tick();
    expect(runner.calls).toEqual(['build', 'announce', 'submit', 'collect']);
    expect((await rt.record(unitId)).unit.attempt).toMatchObject({ id: attemptId, status: 'blocked', blockedOn: 'job' });

    clock = new Date('2026-11-02T12:31:00Z');
    await rt.tick();
    let record = await rt.record(unitId);
    expect(record.unit.attempt).toMatchObject({ id: attemptId, status: 'blocked', blockedOn: 'children' });
    const children = await rt.childrenOf(unitId, rt.lane('smoke'));
    expect(children.map((child) => child.unit.attributes.platform).sort()).toEqual(['linux', 'mac']);
    for (const child of children) expect(await rt.startAttempt(child.unit.id)).toEqual({ kind: 'exit', exit: 'passed' });

    await rt.tick();
    record = await rt.record(unitId);
    expect(record.unit).toMatchObject({ state: 'Released', position: 'terminal', verdict: 'success', attempts: 1, failedAttempts: 0 });
    const ended = (await events({ attemptEnded: true })).filter((e) => e.type === 'attemptEnded' && e.attemptId === attemptId);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ outcome: 'succeeded', exit: 'released' });
    expect(runner.calls.filter((c) => c === 'submit')).toHaveLength(1);
  });

  it('replays after a power cut in a repeatable step: the finished step is not rerun, the running one is, the attempt is the same', async () => {
    const a = runtime('a', { ttl: 50 });
    await a.start();
    const unitId = await startRelease(a);
    runner.crashOnce.add('announce');
    await expect(a.startAttempt(unitId)).rejects.toBeInstanceOf(PowerOff);
    const attemptId = (await a.record(unitId)).unit.attempt!.id;
    expect(runner.calls).toEqual(['build', 'announce']);

    await new Promise((resolve) => setTimeout(resolve, 60));
    const b = runtime('b');
    await b.start();
    expect((await b.record(unitId)).unit.attempt).toMatchObject({ id: attemptId, status: 'blocked', blockedOn: 'interrupted' });
    expect(runner.calls).toEqual(['build', 'announce']);
    const interrupted = await events({ attemptInterrupted: true });
    expect(interrupted).toHaveLength(1);

    const outcome = await b.recover(unitId, 'continue', 'manager');
    expect(outcome).toMatchObject({ kind: 'blocked', step: 'approval', on: 'decision' });
    expect(runner.calls).toEqual(['build', 'announce']);
    expect(driver.requests).toHaveLength(1);
    expect((await b.record(unitId)).unit.attempt?.id).toBe(attemptId);
  });

  it('reruns a repeatable step that was running at the cut, and asks the driver about an agent whose session finished while down', async () => {
    const a = runtime('a', { ttl: 50 });
    await a.start();
    const unitId = await startRelease(a);
    runner.crashOnce.add('build');
    await expect(a.startAttempt(unitId)).rejects.toBeInstanceOf(PowerOff);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const b = runtime('b', { ttl: 50 });
    driver.crashOnce.add('reviewer');
    await expect(b.start()).rejects.toBeInstanceOf(PowerOff);
    expect(runner.calls).toEqual(['build', 'build', 'announce']);
    expect(driver.requests).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const c = runtime('c');
    await c.start();
    expect((await c.record(unitId)).unit.attempt).toMatchObject({ status: 'blocked', blockedOn: 'decision', step: 'approval' });
    expect(driver.requests).toHaveLength(1);
    const invocations = (await events({ invocation: true })).filter((e) => e.type === 'invocation');
    expect(invocations.every((e) => e.type === 'invocation' && e.ok)).toBe(true);
  });

  it('finds a decision recorded while the harness was down and continues from it on start', async () => {
    const a = runtime('a');
    await a.start();
    const unitId = await startRelease(a);
    await a.startAttempt(unitId);
    const attempt = (await a.record(unitId)).unit.attempt!;
    await a.stop();
    const cli = new SqliteLedger({ path: ledger.path });
    await cli.claimWriter('cli', 60_000);
    await cli.append([{ type: 'decisionRecorded', attemptId: attempt.id, step: 'approval', halt: 'approval', decision: { approved: false }, resolvedBy: 'human', by: 'manager-cli', at: clock }], 'cli');
    await cli.releaseWriter('cli');
    cli.close();
    const b = runtime('b');
    await b.start();
    expect((await b.record(unitId)).unit).toMatchObject({ state: 'Rejected', position: 'terminal', verdict: 'failure' });
    const ended = (await events({ attemptEnded: true })).filter((e) => e.type === 'attemptEnded');
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ outcome: 'succeeded', exit: 'rejected' });
  });

  it('blocks an attempt whose flow definition changed, instead of rerunning it', async () => {
    const a = runtime('a');
    await a.start();
    const unitId = await startRelease(a);
    await a.startAttempt(unitId);
    await a.stop();
    const b = runtime('b', { extraStep: true });
    await b.start();
    const outcome = await b.resumeAttempt(unitId);
    expect(outcome).toMatchObject({ kind: 'blocked', on: 'interrupted', detail: 'definitionChanged' });
    const blocked = (await events({ attemptBlocked: true })).filter((e) => e.type === 'attemptBlocked' && e.on === 'definitionChanged');
    expect(blocked).toHaveLength(1);
    expect(runner.calls).toEqual(['build', 'announce']);
  });

  it('retries a failed attempt under the lane policy, then exhausts to the declared state or blocks for the supervisor', async () => {
    const Todo = H.state('Todo', 'pending');
    const Failed = H.terminal('Failed', 'failure');
    const Done = H.terminal('Done', 'success');
    const Kind = H.kind('Job').attributes(z.object({ id: z.string() })).states(Todo, Failed, Done).key((a) => a.id).initial(Todo);
    const flaky = new ScriptedRunner({ work: () => ({ exitCode: 1, stdout: '' }) });
    const local = defineRunner('local', flaky);
    const work = H.command('work').argv(['work']).runner(local);
    const flow = H.flow('work').input(z.object({ id: z.string() })).step('work', work).exit('done');
    const typed = H.lane('typed', Kind).handler(flow, { exits: { done: Done } }).retry({ tries: 1, backoff: 'fixed', initialDelayMs: 1000, exhausted: Failed }).on(H.cancel, { enter: Failed });
    const open = H.lane('open', Kind).handler(flow, { exits: { done: Done } }).retry({ tries: 0 }).on(H.cancel, { enter: Failed });
    const harness = H.harness('retries').ledger(ledger).lanes(typed, open).scheduler(H.scheduler('s').standard(typed, open)).clients(fakeClient('op', [H.ops.attempts.recover]));
    const rt = new Runtime({ harness, drivers: [], resolver, metrics, now, holder: 'r' });
    await rt.start();

    const u1 = (await rt.createUnit(typed, { id: 'u1' }, { source: 'test' }))!;
    expect(await rt.startAttempt(u1)).toMatchObject({ kind: 'failed', step: 'work' });
    let record = await rt.record(u1);
    expect(record.unit).toMatchObject({ state: 'Todo', position: 'pending', failedAttempts: 1 });
    expect(record.notBefore).toEqual(new Date(clock.getTime() + 1000));
    expect(await rt.startAttempt(u1)).toMatchObject({ kind: 'failed' });
    record = await rt.record(u1);
    expect(record.unit).toMatchObject({ state: 'Failed', position: 'terminal', verdict: 'failure', failedAttempts: 2 });

    const u2 = (await rt.createUnit(open, { id: 'u2' }, { source: 'test' }))!;
    expect(await rt.startAttempt(u2)).toMatchObject({ kind: 'failed' });
    record = await rt.record(u2);
    expect(record.unit.attempt).toMatchObject({ status: 'blocked', blockedOn: 'stepFailure' });
    expect(record.unit.position).toBe('waiting');
    await rt.recover(u2, 'abandon', 'op');
    record = await rt.record(u2);
    expect(record.unit).toMatchObject({ state: 'Failed', position: 'terminal' });
    expect(record.unit.attempt).toBeUndefined();
  });

  it('delivers a signal into an open attempt: a gated update is deferred and merged at the end, a rewind keeps the attempt and its loop count', async () => {
    const Drafting = H.state('Drafting', 'pending');
    const Signed = H.terminal('Signed', 'success');
    const Declined = H.terminal('Declined', 'failure');
    const contract = z.object({ id: z.string(), redlines: z.array(z.string()) });
    const Contract = H.kind('Contract').attributes(contract).states(Drafting, Signed, Declined).key((a) => a.id).initial(Drafting);
    const redline = H.signal('redline').payload(z.object({ text: z.string() }));
    const counsel = H.halt('counsel').decision(z.object({ verdict: z.enum(['approve', 'return']) }));
    const drafts = new ScriptedRunner({ draft: (argv) => ({ exitCode: 0, stdout: JSON.stringify({ text: `draft with ${argv.length - 1} redlines` }) }) });
    const local = defineRunner('local', drafts);
    const draft = H.command('draft').input(z.object({ redlines: z.array(z.string()) })).output(z.object({ text: z.string() })).argv((i) => ['draft', ...i.redlines]).runner(local);
    const flow = H.flow('contract')
      .input(contract)
      .loop(
        'review',
        { carry: z.object({ returns: z.number() }), initial: { returns: 0 } },
        (round) => round.step('draft', draft, (ctx) => ({ redlines: ctx.unit.attributes.redlines })).halt('counsel', counsel, { ask: () => 'ok?' }),
        { max: 2, until: (ctx) => ctx.steps.counsel.verdict === 'approve', next: (ctx) => ({ returns: ctx.steps.review.returns + 1 }) },
      )
      .exit('signed', (ctx) => ctx.steps.counsel.verdict === 'approve')
      .exit('declined');
    const lane = H.lane('contracts', Contract)
      .handler(flow, { exits: { signed: Signed, declined: Declined } })
      .retry({ tries: 0, exhausted: Declined })
      .on(redline, { update: (a, p) => ({ ...a, redlines: [...a.redlines, p.text] }), rewind: 'review', at: ['review'] })
      .on(H.cancel, { enter: Declined });
    const harness = H.harness('contracts').ledger(ledger).lanes(lane).scheduler(H.scheduler('s').standard(lane)).clients(fakeClient('counsel', [H.ops.resolve(counsel)]));
    const rt = new Runtime({ harness, drivers: [], resolver, metrics, now, holder: 'c' });
    await rt.start();
    const unitId = (await rt.createUnit(lane, { id: 'c1', redlines: [] }, { source: 'test' }))!;
    expect(await rt.startAttempt(unitId)).toMatchObject({ kind: 'blocked', on: 'decision', step: 'review[0]/counsel' });
    const attemptId = (await rt.record(unitId)).unit.attempt!.id;
    expect(drafts.calls).toEqual(['draft']);

    await rt.deliverSignal('contracts', 'c1', 'redline', { text: 'r1' }, 'webhook');
    let record = await rt.record(unitId);
    expect(record.unit.attributes).toEqual({ id: 'c1', redlines: ['r1'] });
    expect(record.unit.attempt).toMatchObject({ id: attemptId, status: 'blocked', blockedOn: 'decision' });
    expect(drafts.calls).toEqual(['draft', 'draft']);
    const rewound = (await events({ attemptRewound: true })).filter((e) => e.type === 'attemptRewound');
    expect(rewound).toHaveLength(1);
    const iterations = (await events({ loopIteration: true })).filter((e) => e.type === 'loopIteration');
    expect(iterations.map((e) => (e.type === 'loopIteration' ? e.iteration : -1))).toEqual([0]);

    await rt.resolveHalt(unitId, { verdict: 'approve' }, 'counsel');
    record = await rt.record(unitId);
    expect(record.unit).toMatchObject({ state: 'Signed', position: 'terminal' });
    const draftsRun = (await events({ stepEnded: true })).filter((e) => e.type === 'stepEnded' && e.step === 'review[0]/draft');
    expect(draftsRun.map((e) => (e.type === 'stepEnded' ? e.output : null))).toEqual([{ text: 'draft with 0 redlines' }, { text: 'draft with 1 redlines' }]);
  });

  it('skips a create whose key has an open unit and resumes a wait when its timer is due', async () => {
    const rt = runtime('a');
    await rt.start();
    const unitId = await startRelease(rt);
    expect(await rt.createUnit(rt.lane('releases'), { sha: 'abc', platforms: [] }, { source: 'again' })).toBeUndefined();
    const skipped = (await events({ createSkipped: true })).filter((e) => e.type === 'createSkipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ openUnitId: unitId, source: 'again' });
    const outputs = (await events({ unitCreated: true })).filter((e) => e.type === 'unitCreated');
    expect(outputs).toHaveLength(1);
    void (await rt.record(unitId));
    const waited = H.flow('wait').input(z.object({ sha: z.string(), platform: z.string() })).wait('pause', { ms: 60_000 }).exit('passed');
    const lane = H.lane('waits', Smoke).handler(waited, { exits: { passed: Passed } }).retry({ tries: 0, exhausted: Passed }).on(H.cancel, { enter: Passed });
    const harness = H.harness('waits').ledger(ledger).lanes(lane).scheduler(H.scheduler('s').standard(lane));
    await rt.stop();
    const w = new Runtime({ harness, drivers: [], resolver, metrics, now, holder: 'w' });
    await w.start();
    const wid = (await w.createUnit(lane, { sha: 'x', platform: 'y' }, { source: 'test' }))!;
    expect(await w.startAttempt(wid)).toMatchObject({ kind: 'blocked', on: 'timer', step: 'pause' });
    await w.tick();
    expect((await w.record(wid)).unit.attempt).toMatchObject({ status: 'blocked', blockedOn: 'timer' });
    clock = new Date(clock.getTime() + 61_000);
    await w.tick();
    expect((await w.record(wid)).unit).toMatchObject({ state: 'Passed', position: 'terminal' });
    const fired = (await events({ timerFired: true })).filter((e) => e.type === 'timerFired');
    expect(fired).toHaveLength(1);
  });
});
