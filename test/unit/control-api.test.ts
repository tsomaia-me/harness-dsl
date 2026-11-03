import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SqliteLedger } from '../../src/adapters/sqlite/ledger.js';
import { defineRunner, H } from '../../src/dsl/index.js';
import { Runtime } from '../../src/engine/runtime.js';
import type { ControlApi, LedgerEvent, Resolver, RunnerBackend, SequencedEvent } from '../../src/kernel/index.js';
import { eventsOf, fakeAccount, fakeClient, fakeModel, fakeQuota, RecordingMemory, ScriptedDriver } from './scenarios/doubles.js';

const resolver: Resolver = { env: (ref) => ref.name, port: () => 0 };
const T = new Date('2026-11-02T12:00:00Z');
const hours = (n: number) => new Date(T.getTime() + n * 3_600_000);

const Open = H.state('Open', 'pending');
const Done = H.terminal('Done', 'success');
const Rejected = H.terminal('Rejected', 'failure');
const Failed = H.terminal('Failed', 'failure');
const task = z.object({ title: z.string(), slaDueAt: z.string() });
const Task = H.kind('Task').attributes(task).states(Open, Done, Rejected, Failed).key((a) => a.title).initial(Open);
const workerRole = H.role('worker').input(z.object({ title: z.string() })).output(z.object({ verdict: z.string() })).prompt((i) => `work on ${i.title}`);
const approval = H.halt('approval').decision(z.object({ approved: z.boolean() }));
const review = H.halt('review').decision(z.object({ ok: z.boolean() }));
const extend = H.signal('extend').payload(z.object({ slaDueAt: z.string() }));

type Event<T extends LedgerEvent['type']> = Extract<LedgerEvent, { type: T }>;

const runner: { calls: string[][] } & RunnerBackend = {
  calls: [],
  exec: async (command) => {
    runner.calls.push([...command.argv]);
    return { exitCode: 0, stdout: JSON.stringify({ echoed: command.argv[1] }), stderr: '', durationMs: 1 };
  },
};
const local = defineRunner('local', runner);
const echo = H.command('echo').input(z.object({ text: z.string() })).output(z.object({ echoed: z.string() })).argv((i) => ['echo', i.text]).runner(local);

describe('the control API', () => {
  let dir: string;
  let ledger: SqliteLedger;
  let clock: Date;
  let runtime: Runtime;
  let driver: ScriptedDriver;
  let memory: RecordingMemory;
  const clients = {
    approver: fakeClient('approver', [H.ops.resolve(approval), H.ops.work.read]),
    reviewer: fakeClient('reviewer', [H.ops.resolve(review)]),
    operator: fakeClient('operator', [
      H.ops.work.create,
      H.ops.work.read,
      H.ops.work.update,
      H.ops.work.cancel,
      H.ops.work.signal,
      H.ops.attempts.recover,
      H.ops.lanes.pause,
      H.ops.memory.read,
      H.ops.memory.write,
      H.ops.memory.curate,
      H.ops.telemetry.read,
      H.ops.accounts.read,
      H.ops.accounts.share,
      H.operation('echo', echo),
    ]),
  };
  const api = (name: keyof typeof clients): ControlApi => runtime.controlApiFor(clients[name]);

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'harness-control-'));
    ledger = new SqliteLedger({ path: path.join(dir, 'ledger.sqlite') });
    clock = T;
    runner.calls.length = 0;
    driver = new ScriptedDriver((request) => {
      if ((request.input as { title: string }).title === 'broken') throw new Error('the model fell over');
      return { output: { verdict: 'ok' }, costUsd: 0.25, tokens: 10 };
    });
    memory = new RecordingMemory('mem');
    const account = fakeAccount('x', 'test', fakeQuota('q'));
    const worker = H.seat('worker').role(workerRole).model(fakeModel('m', 'test', 'm-id')).pool(H.pool('p').accounts(account));
    const flow = H.flow('work')
      .input(task)
      .step('work', worker, (ctx) => ({ title: ctx.unit.attributes.title }))
      .halt('approval', approval, { ask: (ctx) => `approve ${ctx.unit.attributes.title}?` })
      .exit('rejected', (ctx) => !ctx.steps.approval.approved)
      .halt('review', review, { ask: () => 'reviewed?' })
      .exit('done');
    const tasks = H.lane('tasks', Task)
      .supply(H.operator)
      .handler(flow, { exits: { done: Done, rejected: Rejected } })
      .retry({ tries: 0 })
      .on(extend, { update: (a, p) => ({ ...a, slaDueAt: p.slaDueAt }) })
      .on(H.cancel, { enter: Failed });
    const sla = H.trigger('sla').on(H.when.timer(tasks, { at: (unit) => new Date(unit.attributes.slaDueAt) })).do((_e, act) => act.pause(tasks, 'sla breached'));
    const lessons = H.journal('lessons', H.memory('experience', 'experience')).store(memory).readBy(workerRole);
    const harness = H.harness('control')
      .ledger(ledger)
      .lanes(tasks)
      .journals(lessons)
      .triggers(sla)
      .scheduler(H.scheduler('s').standard(tasks))
      .clients(clients.approver, clients.reviewer, clients.operator);
    runtime = new Runtime({ harness, drivers: [driver], resolver, now: () => clock, holder: 'control' });
    await runtime.start();
  });

  afterEach(async () => {
    await runtime.stop();
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('scopes the operations to the client\'s grants and names no timer operation', async () => {
    const names = api('operator').operations().map((operation) => operation.name);
    expect.soft(names).toEqual(expect.arrayContaining(['work.create', 'work.update', 'lanes.pause', 'lanes.resume', 'custom.echo', 'telemetry.read']));
    expect.soft(names).not.toContain('halts.resolve');
    expect.soft(names.some((name) => /timer/i.test(name))).toBe(false);
    expect.soft(api('approver').operations().map((operation) => operation.name)).toEqual(['work.read', 'halts.resolve']);
    expect.soft(api('operator').operations().find((operation) => operation.name === 'work.create')?.inputSchema).toMatchObject({ type: 'object', properties: { lane: { type: 'string' } } });
    await expect(api('approver').call('work.create', { lane: 'tasks', attributes: { title: 'one', slaDueAt: hours(1).toISOString() } }, 'approver')).rejects.toThrow(/client "approver" may not call "work.create"/);
  });

  it('lets a client resolve only the halts its grant names', async () => {
    const created = (await api('operator').call('work.create', { lane: 'tasks', attributes: { title: 'one', slaDueAt: hours(1).toISOString() } }, 'operator')) as { unitId: string };
    await runtime.tick();
    expect.soft((await runtime.find(created.unitId))?.unit.attempt).toMatchObject({ status: 'blocked', blockedOn: 'decision', halt: 'approval' });
    await expect(api('reviewer').call('halts.resolve', { unitId: created.unitId, decision: { ok: true } }, 'reviewer')).rejects.toThrow(/client "reviewer" may not resolve halt "approval"/);
    await expect(api('operator').call('halts.resolve', { unitId: created.unitId, decision: { approved: true } }, 'operator')).rejects.toThrow(/may not call "halts.resolve"/);
    expect.soft(await api('approver').call('halts.resolve', { unitId: created.unitId, decision: { approved: true } }, 'approver')).toEqual({ outcome: { kind: 'blocked', step: 'review', on: 'decision', ask: 'reviewed?', facets: [] } });
    expect.soft((await runtime.find(created.unitId))?.unit.attempt?.halt).toBe('review');
    await expect(api('approver').call('halts.resolve', { unitId: created.unitId, decision: { ok: true } }, 'approver')).rejects.toThrow(/may not resolve halt "review"/);
    expect.soft(await api('reviewer').call('halts.resolve', { unitId: created.unitId, decision: { ok: true } }, 'reviewer')).toEqual({ outcome: { kind: 'exit', exit: 'done' } });
    const decisions = (await eventsOf(ledger, 'decisionRecorded')) as Event<'decisionRecorded'>[];
    expect.soft(decisions.map((event) => [event.halt, event.resolvedBy, event.by])).toEqual([
      ['approval', 'human', 'client:approver'],
      ['review', 'human', 'client:reviewer'],
    ]);
    const read = (await api('approver').call('work.read', { unitId: created.unitId }, 'approver')) as { units: { state: { name: string }; position: string }[] };
    expect(read.units[0]).toMatchObject({ state: { name: 'Done' }, position: 'terminal' });
  });

  it('applies an update at once without touching a timer the update does not feed, and moves one it does', async () => {
    const created = (await api('operator').call('work.create', { lane: 'tasks', attributes: { title: 'two', slaDueAt: hours(1).toISOString() } }, 'operator')) as { unitId: string };
    await runtime.tick();
    const armed = (await eventsOf(ledger, 'timerSet')) as Event<'timerSet'>[];
    expect.soft(armed.filter((event) => event.owner === 'trigger:sla').map((event) => event.fireAt)).toEqual([hours(1)]);
    await expect(api('operator').call('work.update', { unitId: created.unitId, attributes: { title: 5 } }, 'operator')).rejects.toThrow(/attributes/);
    expect.soft(await api('operator').call('work.update', { unitId: created.unitId, attributes: { title: 'two renamed' } }, 'operator')).toEqual({ applied: true });
    await runtime.tick();
    const updates = (await eventsOf(ledger, 'attributesUpdated')) as Event<'attributesUpdated'>[];
    expect.soft(updates.map((event) => [event.by, event.applied, event.attributes])).toEqual([['client:operator', true, { title: 'two renamed', slaDueAt: hours(1).toISOString() }]]);
    expect.soft((await eventsOf(ledger, 'timerSet')).filter((event) => event.type === 'timerSet' && event.reason === 'moved')).toHaveLength(0);
    await api('operator').call('work.update', { unitId: created.unitId, attributes: { slaDueAt: hours(3).toISOString() } }, 'operator');
    await runtime.tick();
    const moved = (await eventsOf(ledger, 'timerSet')).filter((event): event is Event<'timerSet'> => event.type === 'timerSet' && event.reason === 'moved');
    expect(moved.map((event) => event.fireAt)).toEqual([hours(3)]);
  });

  it('pauses and resumes lanes, cancels and signals units, and recovers a blocked attempt', async () => {
    const created = (await api('operator').call('work.create', { lane: 'tasks', attributes: { title: 'three', slaDueAt: hours(1).toISOString() } }, 'operator')) as { unitId: string };
    expect.soft(await api('operator').call('lanes.pause', { lane: 'tasks', reason: 'maintenance' }, 'operator')).toEqual({ paused: true });
    await runtime.tick();
    expect.soft((await runtime.find(created.unitId))?.unit.attempt).toBeUndefined();
    expect.soft(await api('operator').call('lanes.resume', { lane: 'tasks', reason: 'maintenance over' }, 'operator')).toEqual({ paused: false });
    await runtime.tick();
    expect.soft((await runtime.find(created.unitId))?.unit.attempt?.halt).toBe('approval');
    const paused = (await eventsOf(ledger, 'lanePaused')) as Event<'lanePaused'>[];
    expect.soft(paused.map((event) => [event.lane, event.reason, event.by])).toEqual([['tasks', 'maintenance', 'client:operator']]);
    expect.soft(await api('operator').call('work.signal', { lane: 'tasks', key: 'three', signal: 'extend', payload: { slaDueAt: hours(5).toISOString() } }, 'operator')).toEqual({ delivered: true });
    expect.soft(await api('operator').call('work.cancel', { unitId: created.unitId, reason: 'no longer needed' }, 'operator')).toEqual({ delivered: true });
    const record = await runtime.find(created.unitId);
    expect.soft(record?.unit).toMatchObject({ state: 'Failed', position: 'terminal', attributes: { slaDueAt: hours(5).toISOString() } });
    expect.soft(record?.unit.attempt).toBeUndefined();

    const broken = (await api('operator').call('work.create', { lane: 'tasks', attributes: { title: 'broken', slaDueAt: hours(1).toISOString() } }, 'operator')) as { unitId: string };
    await runtime.tick();
    expect.soft((await runtime.find(broken.unitId))?.unit.attempt).toMatchObject({ status: 'blocked', blockedOn: 'stepFailure' });
    const invocations = (await eventsOf(ledger, 'invocation')) as Event<'invocation'>[];
    expect.soft(invocations.filter((event) => !event.ok).map((event) => event.seat)).toEqual(['worker']);
    expect.soft(await api('operator').call('attempts.recover', { unitId: broken.unitId, action: 'abandon' }, 'operator')).toEqual({ recovered: 'abandon' });
    expect((await runtime.find(broken.unitId))?.unit).toMatchObject({ state: 'Failed', position: 'terminal' });
  });

  it('reads and writes memory, reads telemetry and accounts, shares an account, runs a custom operation, and streams events', async () => {
    const seen: SequencedEvent[] = [];
    const unsubscribe = api('operator').subscribe((event) => seen.push(event));
    const written = (await api('operator').call('memory.write', { journal: 'lessons', text: 'run the checks', when: { kinds: ['Task'] }, status: 'candidate' }, 'operator')) as { id: string };
    expect.soft(memory.items.map((item) => [item.id === written.id, item.status, item.when.kinds])).toEqual([[true, 'candidate', ['Task']]]);
    expect.soft(await api('operator').call('memory.curate', { journal: 'lessons', id: written.id, status: 'active' }, 'operator')).toEqual({ curated: true });
    const read = (await api('operator').call('memory.read', { journal: 'lessons', status: ['active'] }, 'operator')) as { items: { id: string }[] };
    expect.soft(read.items.map((item) => item.id)).toEqual([written.id]);

    const created = (await api('operator').call('work.create', { lane: 'tasks', attributes: { title: 'four', slaDueAt: hours(1).toISOString() } }, 'operator')) as { unitId: string };
    await runtime.tick();
    await api('approver').call('halts.resolve', { unitId: created.unitId, decision: { approved: false } }, 'approver');
    await runtime.tick();
    const telemetry = (await api('operator').call('telemetry.read', {}, 'operator')) as { lanes: { lane: string; outcomes: { terminal: number; failure: number }; attempts: { succeeded: number } }[]; seats: { seat: string; attempts: { succeeded: number } }[]; halts: { halt: string; decisions: { samples: number } }[] };
    expect.soft(telemetry.lanes).toEqual([{ lane: 'tasks', outcomes: expect.objectContaining({ terminal: 1, failure: 1 }), attempts: expect.objectContaining({ succeeded: 1 }), paused: expect.objectContaining({ count: 0 }) }]);
    expect.soft(telemetry.seats).toEqual([{ seat: 'worker', model: 'm', attempts: expect.objectContaining({ succeeded: 1 }) }]);
    expect.soft(telemetry.halts).toEqual(expect.arrayContaining([{ halt: 'approval', decisions: expect.objectContaining({ samples: 1 }) }]));
    expect.soft(driver.requests[0]?.memory.map((item) => item.id)).toEqual([written.id]);

    const accounts = (await api('operator').call('accounts.read', {}, 'operator')) as { accounts: { name: string; shareCap: number; shareUsed: number }[] };
    expect.soft(accounts.accounts).toEqual([expect.objectContaining({ name: 'x', driver: 'test', partition: 'q', shareCap: 1 })]);
    expect.soft(await api('operator').call('accounts.share', { account: 'x', fraction: 0.5 }, 'operator')).toEqual({ applied: true });
    expect.soft(((await api('operator').call('accounts.read', {}, 'operator')) as { accounts: { shareCap: number }[] }).accounts[0]?.shareCap).toBe(0.5);
    expect.soft(runtime.shareFor({ entity: 'account', name: 'x', driver: 'test', credential: { ref: 'env', name: 'X' }, quota: fakeQuota('q') })).toBe(0.5);

    expect.soft(await api('operator').call('custom.echo', { text: 'hello' }, 'operator')).toEqual({ ok: true, exitCode: 0, output: { echoed: 'hello' } });
    expect.soft(runner.calls).toEqual([['echo', 'hello']]);
    unsubscribe();
    expect.soft(seen.map((entry) => entry.event.type)).toEqual(expect.arrayContaining(['unitCreated', 'attemptStarted', 'decisionRecorded', 'accountShared']));
    expect(seen.every((entry, index) => index === 0 || entry.seq > seen[index - 1]!.seq)).toBe(true);
  });
});
