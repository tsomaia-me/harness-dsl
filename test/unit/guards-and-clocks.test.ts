import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { claudeCode } from '../../src/adapters/claude-code/index.js';
import { SqliteLedger } from '../../src/adapters/sqlite/ledger.js';
import { defineRunner, defineWorkspace, H } from '../../src/dsl/index.js';
import { Runtime } from '../../src/engine/runtime.js';
import type { LedgerEvent, Resolver, RunnerBackend } from '../../src/kernel/index.js';
import { eventsOf, fakeAccount, fakeClient, fakeModel, fakeQuota, ScriptedDriver } from './scenarios/doubles.js';

const resolver: Resolver = { env: (ref) => `secret-${ref.name}`, port: () => 0 };
const T = new Date('2026-11-02T12:00:00Z');
const minutes = (n: number) => new Date(T.getTime() + n * 60_000);
type Event<T extends LedgerEvent['type']> = Extract<LedgerEvent, { type: T }>;

const Open = H.state('Open', 'pending');
const Done = H.terminal('Done', 'success');
const Rejected = H.terminal('Rejected', 'failure');
const Task = H.kind('Task').attributes(z.object({ title: z.string() })).states(Open, Done, Rejected).key((a) => a.title).initial(Open);
const builderRole = H.role('builder').input(z.object({ title: z.string() })).output(z.object({ verdict: z.string() })).prompt((i) => `build ${i.title}`).intents('edit');
const approval = H.halt('approval').decision(z.object({ approved: z.boolean() }));

type HookPost = (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;

describe('guards through the hook protocol', () => {
  let dir: string;
  let ledger: SqliteLedger;
  let runtime: Runtime;
  let clock: Date;
  const checks: string[] = [];
  const runner: RunnerBackend = {
    exec: async (command) => {
      checks.push(command.argv[0]!);
      return checks.length === 1 ? { exitCode: 1, stdout: '', stderr: 'tests red', durationMs: 1 } : { exitCode: 0, stdout: 'green', stderr: '', durationMs: 1 };
    },
  };
  const scripts: ((post: HookPost) => Promise<void>)[] = [];
  const settingsSeen: Record<string, unknown>[] = [];

  function endpointIn(settings: Record<string, any>): string {
    const command = settings.hooks.PreToolUse?.[0]?.hooks?.[0]?.command ?? settings.hooks.Stop?.[0]?.hooks?.[0]?.command;
    const match = /"(http[^"]+)"/.exec(String(command));
    if (!match) throw new Error('no endpoint in the settings');
    return match[1]!;
  }

  const spawnBridge = async (args: readonly string[], _env: Record<string, string>, _cwd: string, onLine: (line: string) => void) => {
    const at = args.indexOf('--settings');
    if (at !== -1) {
      const settings = JSON.parse(readFileSync(args[at + 1]!, 'utf8')) as Record<string, unknown>;
      settingsSeen.push(settings);
      const endpoint = endpointIn(settings);
      const post: HookPost = async (payload) => (await (await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })).json()) as Record<string, unknown>;
      const script = scripts.shift();
      if (script) await script(post);
    }
    onLine(JSON.stringify({ type: 'result', structured_output: { result: { verdict: 'built' } } }));
    return { exitCode: 0, stderr: '' };
  };

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'harness-guards-'));
    ledger = new SqliteLedger({ path: path.join(dir, 'ledger.sqlite') });
    clock = T;
    checks.length = 0;
    scripts.length = 0;
    settingsSeen.length = 0;
    const Areas = H.resources('area', ['api', 'web']);
    const workspace = defineWorkspace('ws', { prepare: async () => ({ path: dir }), release: async () => undefined }).withAreas(Areas, { api: ['src/api/**'], web: ['src/web/**'] });
    const local = defineRunner('local', runner);
    const checksCommand = H.command('checks').argv(['checks']).runner(local);
    const account = claudeCode.subscription('max', { token: H.env('MAX_TOKEN'), quota: fakeQuota('q') });
    const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-5-5' });
    const builder = H.seat('builder').role(builderRole).model(sonnet).pool(H.pool('subs').accounts(account));
    const flow = H.flow('build')
      .input(z.object({ title: z.string() }))
      .step('build', builder, (ctx) => ({ title: ctx.unit.attributes.title }), { workspace, guard: { leases: Areas, beforeStop: checksCommand } })
      .halt('approval', approval, { ask: (ctx) => `ship ${ctx.unit.attributes.title}?` })
      .exit('rejected', (ctx) => !ctx.steps.approval.approved)
      .exit('done');
    const tasks = H.lane('tasks', Task).supply(H.operator).handler(flow, { exits: { done: Done, rejected: Rejected } }).retry({ tries: 0, exhausted: Rejected }).on(H.cancel, { enter: Rejected });
    const harness = H.harness('guarded').ledger(ledger).lanes(tasks).scheduler(H.scheduler('s').standard(tasks).wip(tasks, 2)).clients(fakeClient('owner', [H.ops.resolve(approval)]));
    runtime = new Runtime({
      harness,
      drivers: [claudeCode.driver({ spawnBridge, workDir: dir, sessionDir: path.join(dir, 'sessions') })],
      resolver,
      now: () => clock,
      holder: 'guarded',
      hooks: { port: 0 },
    });
    await runtime.start();
  });

  afterEach(async () => {
    await runtime.stop();
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('leases the areas an agent writes, refuses another attempt those areas, gates the stop on the check, and releases at the end', async () => {
    scripts.push(async (post) => {
      expect.soft(await post({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'src/api/a.ts', content: 'x' } })).toEqual({});
      expect.soft(await post({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/web/b.ts') } })).toEqual({});
      expect.soft(await post({ hook_event_name: 'Stop' })).toEqual({ decision: 'block', reason: expect.stringContaining('checks') });
      expect.soft(await post({ hook_event_name: 'Stop' })).toEqual({});
    });
    const first = (await runtime.createUnit(runtime.lane('tasks'), { title: 'first' }, { source: 'test' }))!;
    await runtime.startAttempt(first);
    expect.soft((await runtime.find(first))?.unit.attempt).toMatchObject({ status: 'blocked', halt: 'approval' });
    expect.soft(checks).toEqual(['checks', 'checks']);
    const firstAttempt = (await runtime.find(first))!.unit.attempt!.id;
    const taken = (await eventsOf(ledger, 'leaseTaken')) as Event<'leaseTaken'>[];
    expect.soft(taken.map((event) => [event.attemptId === firstAttempt, event.resource, event.mode])).toEqual([
      [true, 'area:api', 'exclusive'],
      [true, 'area:web', 'exclusive'],
    ]);
    expect.soft(settingsSeen[0]).toMatchObject({ hooks: { PreToolUse: [expect.objectContaining({ matcher: 'Edit|Write|MultiEdit|NotebookEdit' })], Stop: [expect.anything()] } });

    scripts.push(async (post) => {
      expect.soft(await post({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'src/api/c.ts' } })).toEqual({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('area:api') },
      });
      expect.soft(await post({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'docs/readme.md' } })).toEqual({});
      expect.soft(await post({ hook_event_name: 'Stop' })).toEqual({});
    });
    const second = (await runtime.createUnit(runtime.lane('tasks'), { title: 'second' }, { source: 'test' }))!;
    await runtime.startAttempt(second);
    expect.soft((await runtime.find(second))?.unit.attempt).toMatchObject({ status: 'blocked', halt: 'approval' });

    await runtime.resolveHalt(first, { approved: true }, 'owner');
    expect.soft((await runtime.find(first))?.unit).toMatchObject({ state: 'Done', position: 'terminal' });
    const released = (await eventsOf(ledger, 'leaseReleased')) as Event<'leaseReleased'>[];
    expect.soft(released.map((event) => [event.attemptId === firstAttempt, event.resource])).toEqual([
      [true, 'area:api'],
      [true, 'area:web'],
    ]);
    const unknown = await fetch(`${runtime.hookEndpoint()}/internal/hook?invocation=nobody`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hook_event_name: 'Stop' }) });
    expect(await unknown.json()).toEqual({});
  });
});

describe('halt clocks', () => {
  let dir: string;
  let ledger: SqliteLedger;
  let runtime: Runtime;
  let clock: Date;
  const notified: string[] = [];
  const runner: RunnerBackend = {
    exec: async (command) => {
      notified.push(command.argv.join(' '));
      return { exitCode: 0, stdout: '', stderr: '', durationMs: 1 };
    },
  };

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'harness-clocks-'));
    ledger = new SqliteLedger({ path: path.join(dir, 'ledger.sqlite') });
    clock = T;
    notified.length = 0;
    const local = defineRunner('local', runner);
    const notify = H.command('notify').argv(['notify', 'owner']).runner(local);
    const worker = H.seat('worker').role(builderRole).model(fakeModel('m', 'test', 'm-id')).pool(H.pool('p').accounts(fakeAccount('x', 'test', fakeQuota('q'))));
    const flow = H.flow('work')
      .input(z.object({ title: z.string() }))
      .step('work', worker, (ctx) => ({ title: ctx.unit.attributes.title }))
      .halt('approval', approval, {
        ask: (ctx) => `ship ${ctx.unit.attributes.title}?`,
        escalate: { afterMinutes: 10, run: notify },
        timeout: { afterMinutes: 30, decide: () => ({ approved: false }) },
      })
      .exit('rejected', (ctx) => !ctx.steps.approval.approved)
      .exit('done');
    const tasks = H.lane('tasks', Task).supply(H.operator).handler(flow, { exits: { done: Done, rejected: Rejected } }).retry({ tries: 0, exhausted: Rejected }).on(H.cancel, { enter: Rejected });
    const harness = H.harness('clocked').ledger(ledger).lanes(tasks).scheduler(H.scheduler('s').standard(tasks).wip(tasks, 2)).clients(fakeClient('owner', [H.ops.resolve(approval)]));
    runtime = new Runtime({ harness, drivers: [new ScriptedDriver(() => ({ output: { verdict: 'built' }, costUsd: 0, tokens: 1 }))], resolver, now: () => clock, holder: 'clocked' });
    await runtime.start();
  });

  afterEach(async () => {
    await runtime.stop();
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('escalates after its delay, resolves by timeout, and disarms both clocks when a human answers first', async () => {
    const slow = (await runtime.createUnit(runtime.lane('tasks'), { title: 'slow' }, { source: 'test' }))!;
    const quick = (await runtime.createUnit(runtime.lane('tasks'), { title: 'quick' }, { source: 'test' }))!;
    await runtime.tick();
    const quickAttempt = (await runtime.find(quick))!.unit.attempt!.id;
    const armed = (await eventsOf(ledger, 'timerSet')) as Event<'timerSet'>[];
    expect.soft(armed.filter((event) => event.unitId === slow).map((event) => [event.owner, event.fireAt])).toEqual([
      ['escalate:approval', minutes(10)],
      ['timeout:approval', minutes(30)],
    ]);
    await runtime.resolveHalt(quick, { approved: true }, 'owner');
    const cleared = (await eventsOf(ledger, 'timerCleared')) as Event<'timerCleared'>[];
    expect.soft(cleared.map((event) => [event.timerId.startsWith(quickAttempt), event.reason])).toEqual([
      [true, 'disarmed'],
      [true, 'disarmed'],
    ]);

    clock = minutes(10);
    await runtime.tick();
    expect.soft(notified).toEqual(['notify owner']);
    const escalated = (await eventsOf(ledger, 'haltEscalated')) as Event<'haltEscalated'>[];
    expect.soft(escalated.map((event) => [event.step, event.halt])).toEqual([['approval', 'approval']]);
    expect.soft((await runtime.find(slow))?.unit.attempt).toMatchObject({ status: 'blocked', halt: 'approval' });

    clock = minutes(30);
    await runtime.tick();
    const decisions = (await eventsOf(ledger, 'decisionRecorded')) as Event<'decisionRecorded'>[];
    expect.soft(decisions.map((event) => [event.halt, event.resolvedBy, event.decision])).toEqual([
      ['approval', 'human', { approved: true }],
      ['approval', 'timeout', { approved: false }],
    ]);
    expect((await runtime.find(slow))?.unit).toMatchObject({ state: 'Rejected', position: 'terminal' });
  });
});
