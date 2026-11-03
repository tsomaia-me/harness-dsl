import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SqliteLedger } from '../../src/adapters/sqlite/ledger.js';
import { defineRunner, H } from '../../src/dsl/index.js';
import { Runtime } from '../../src/engine/runtime.js';
import type { LedgerEvent, MemoryItem, MemoryStore, Resolver, RunnerBackend, Supplier, SupplySink } from '../../src/kernel/index.js';
import { fakeClient } from './scenarios/doubles.js';

class TestSupplier<E> implements Supplier<E> {
  public readonly entity = 'supplier' as const;
  private sink: SupplySink<E> | undefined;
  public constructor(public readonly name: string) {}
  public async start(sink: SupplySink<E>) {
    this.sink = sink;
    return { stop: async () => undefined };
  }
  public push(event: E, id: string): Promise<void> {
    if (!this.sink) throw new Error('supplier not started');
    return this.sink.emit(event, id);
  }
}

class RecordingMemory implements MemoryStore {
  public readonly entity = 'memoryStore' as const;
  public readonly items: MemoryItem[] = [];
  public constructor(public readonly name: string) {}
  public async put(item: MemoryItem) {
    this.items.push(item);
  }
  public async list() {
    return this.items;
  }
  public async update() {}
}

const resolver: Resolver = { env: (ref) => ref.name, port: () => 0 };
const backend: RunnerBackend = { exec: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }) };

const New = H.state('New', 'pending');
const Sent = H.terminal('Sent', 'success');
const Rejected = H.terminal('Rejected', 'failure');
const Open = H.state('Open', 'pending');
const Closed = H.terminal('Closed', 'neutral');
const Category = H.facet('category', ['billing', 'refund']);
const conversation = z.object({ id: z.string(), category: z.enum(['billing', 'refund']), slaDueAt: z.string() });
const Conversation = H.kind('Conversation').attributes(conversation).states(New, Sent, Rejected).key((a) => a.id).initial(New);
const Audit = H.kind('Audit').attributes(z.object({ key: z.string(), reason: z.string() })).states(Open, Closed).key((a) => a.key).initial(Open);
const approval = H.halt('approval').decision(z.object({ approved: z.boolean() }));
const extend = H.signal('extend').payload(z.object({ slaDueAt: z.string() }));

describe('lanes, demand, triggers and metrics', () => {
  let dir: string;
  let ledger: SqliteLedger;
  let clock: Date;
  const now = () => clock;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'harness-lanes-'));
    ledger = new SqliteLedger({ path: path.join(dir, 'ledger.sqlite') });
    clock = new Date('2026-11-02T12:00:00Z');
  });

  afterEach(() => {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function events(type: LedgerEvent['type']): Promise<LedgerEvent[]> {
    const out: LedgerEvent[] = [];
    for await (const { event } of ledger.read({ types: [type] })) out.push(event);
    return out;
  }

  it('acknowledges supply durably, meters demand by WIP, pauses on a crossing per facet with hysteresis, dedups by key, re-arms a timer, and folds metrics', async () => {
    const local = defineRunner('local', backend);
    const draft = H.command('draft').argv(['draft']).runner(local);
    const flow = H.flow('triage')
      .input(conversation)
      .step('draft', draft)
      .halt('approval', approval, { ask: () => 'send?', facets: (ctx) => [Category.of(ctx.unit.attributes.category)] })
      .exit('sent', (ctx) => ctx.steps.approval.approved)
      .exit('rejected');
    const auditFlow = H.flow('audit').input(z.object({ key: z.string(), reason: z.string() })).exit('closed');
    const supplier = new TestSupplier<{ id: string; category: 'billing' | 'refund'; slaDueAt: string }>('helpdesk');
    const conversations = H.lane('conversations', Conversation)
      .supply(supplier, (event, to) => to.create(event))
      .handler(flow, { exits: { sent: Sent, rejected: Rejected } })
      .retry({ tries: 0, exhausted: Rejected })
      .on(extend, { update: (a, p) => ({ ...a, slaDueAt: p.slaDueAt }) })
      .on(H.cancel, { enter: Rejected });
    const audits = H.lane('audits', Audit).handler(auditFlow, { exits: { closed: Closed } }).retry({ tries: 0, exhausted: Closed }).on(H.cancel, { enter: Closed });
    const approvals = H.metric('approvals', H.when.decision(Conversation, approval)).samples((e) => [{ hit: e.decision.approved, facets: e.facets }]);
    const memory = new RecordingMemory('exp');
    const experience = H.journal('experience', H.memory('experience', 'experience')).store(memory);
    const band = { window: { lastDays: 7 }, minSamples: 2, enter: { below: 0.6 }, exit: { above: 0.8 }, per: Category } as const;
    const lowApproval = H.trigger('low-approval')
      .on(H.when.crossing(approvals, band, 'entered'))
      .do((e, act) => [
        act.create(audits, { key: `audit:${e.group.value}`, reason: `approval rate ${e.rate.toFixed(2)} over ${e.samples}` }),
        act.pause(audits, `approval rate ${e.rate.toFixed(2)}`),
        act.record(experience, { text: `when drafting for ${e.group.value}, recall the stricter phrasing`, when: { facets: [e.group] } }),
      ]);
    const recovered = H.trigger('approval-recovered').on(H.when.crossing(approvals, band, 'exited')).do((e, act) => act.resume(audits, `approval rate ${e.rate.toFixed(2)}`));
    const twoRejected = H.trigger('two-rejected')
      .on(H.when.pattern(conversations, { to: Rejected, consecutive: 2, per: (unit) => Category.of(unit.attributes.category) }))
      .do((e, act) => act.create(audits, { key: `audit:${e.group.value}`, reason: `${e.streak} rejected in a row` }));
    const sla = H.trigger('sla-breach')
      .on(H.when.timer(conversations, { at: (unit) => new Date(unit.attributes.slaDueAt) }))
      .do((e, act) => act.create(audits, { key: `sla:${e.unit.attributes.id}`, reason: 'sla breached' }));
    const harness = H.harness('support')
      .ledger(ledger)
      .lanes(conversations, audits)
      .journals(experience)
      .metrics(approvals)
      .triggers(lowApproval, recovered, twoRejected, sla)
      .scheduler(H.scheduler('s').standard(conversations, audits).wip(conversations, 1))
      .clients(fakeClient('reviewer', [H.ops.resolve(approval), H.ops.work.cancel]));
    const rt = new Runtime({ harness, drivers: [], resolver, now, holder: 'support' });
    await rt.start();

    const due = new Date(clock.getTime() + 3_600_000).toISOString();
    for (let i = 1; i <= 3; i += 1) await supplier.push({ id: `c${i}`, category: 'billing', slaDueAt: due }, `evt-${i}`);
    const created = await events('unitCreated');
    expect(created.filter((e) => e.type === 'unitCreated' && e.lane === 'conversations')).toHaveLength(3);
    expect(created.map((e) => (e.type === 'unitCreated' ? e.source : ''))).toEqual(['helpdesk:evt-1', 'helpdesk:evt-2', 'helpdesk:evt-3']);

    await rt.tick();
    expect((await events('timerSet')).filter((e) => e.type === 'timerSet' && e.owner === 'trigger:sla-breach')).toHaveLength(3);
    let units = await ledger.units({ lane: 'conversations' });
    expect(units.filter((u) => u.unit.attempt !== undefined).map((u) => u.unit.key)).toEqual(['c1']);
    const c1 = units.find((u) => u.unit.key === 'c1')!.unit.id;
    expect((await rt.resolveHalt(c1, { approved: false }, 'reviewer'))).toEqual({ kind: 'exit', exit: 'rejected' });
    await rt.tick();
    units = await ledger.units({ lane: 'conversations' });
    expect(units.filter((u) => u.unit.attempt !== undefined).map((u) => u.unit.key)).toEqual(['c2']);
    const c2 = units.find((u) => u.unit.key === 'c2')!.unit.id;
    await rt.resolveHalt(c2, { approved: false }, 'reviewer');
    await rt.tick();

    const fired = (await events('triggerFired')).filter((e): e is Extract<LedgerEvent, { type: 'triggerFired' }> => e.type === 'triggerFired');
    expect(fired.map((e) => `${e.trigger}:${e.consequence}:${e.result}`)).toEqual([
      'two-rejected:create:applied',
      'low-approval:create:deduped',
      'low-approval:pause:applied',
      'low-approval:record:applied',
    ]);
    expect((await ledger.units({ lane: 'audits' })).map((u) => u.unit.key)).toEqual(['audit:billing']);
    expect(memory.items).toHaveLength(1);
    expect(memory.items[0]).toMatchObject({ status: 'candidate', when: { facets: [{ facet: 'category', value: 'billing' }] } });
    const crossings = (await events('crossing')).filter((e): e is Extract<LedgerEvent, { type: 'crossing' }> => e.type === 'crossing');
    expect(crossings).toHaveLength(1);
    expect(crossings[0]).toMatchObject({ metric: 'approvals', edge: 'entered', group: { facet: 'category', value: 'billing' }, hits: 0, samples: 2 });
    expect(rt.pausedLanes().has('audits')).toBe(true);
    await rt.tick();
    expect((await ledger.units({ lane: 'audits' }))[0]!.unit.attempt).toBeUndefined();

    const c3 = units.find((u) => u.unit.key === 'c3')!.unit.id;
    await rt.deliverSignal('conversations', 'c3', 'extend', { slaDueAt: new Date(clock.getTime() + 3 * 3_600_000).toISOString() }, 'reviewer');
    await rt.tick();
    const moved = (await events('timerSet')).filter((e) => e.type === 'timerSet' && e.reason === 'moved');
    expect(moved).toHaveLength(1);
    expect((await rt.record(c3)).unit.attempt).toBeDefined();
    await rt.resolveHalt(c3, { approved: true }, 'reviewer');
    for (let i = 4; i <= 11; i += 1) {
      await supplier.push({ id: `c${i}`, category: 'billing', slaDueAt: new Date(clock.getTime() + 5 * 3_600_000).toISOString() }, `evt-${i}`);
      await rt.tick();
      const unit = (await ledger.units({ lane: 'conversations', key: `c${i}` }))[0]!.unit.id;
      await rt.resolveHalt(unit, { approved: true }, 'reviewer');
    }
    await rt.tick();
    const after = (await events('crossing')).filter((e): e is Extract<LedgerEvent, { type: 'crossing' }> => e.type === 'crossing');
    expect(after.map((e) => `${e.edge}@${e.hits}/${e.samples}`)).toEqual(['entered@0/2', 'exited@9/11']);
    expect(rt.pausedLanes().has('audits')).toBe(false);
    await rt.tick();
    expect((await ledger.units({ lane: 'audits' }))[0]!.unit).toMatchObject({ state: 'Closed', position: 'terminal' });

    clock = new Date(clock.getTime() + 2 * 3_600_000);
    await rt.tick();
    expect((await events('timerFired')).filter((e) => e.type === 'timerFired')).toHaveLength(0);
    clock = new Date(clock.getTime() + 2 * 3_600_000);
    await rt.tick();
    const slaAudits = (await ledger.units({ lane: 'audits' })).map((u) => u.unit.key).filter((key) => key.startsWith('sla:'));
    expect(slaAudits).toEqual([]);
    const firedTimers = (await events('timerFired')).filter((e) => e.type === 'timerFired');
    expect(firedTimers).toHaveLength(0);
    const cleared = (await events('timerCleared')).filter((e) => e.type === 'timerCleared' && e.reason === 'unitTerminal');
    expect(cleared.length).toBeGreaterThanOrEqual(11);

    const metrics = rt.metrics;
    expect(metrics.decisions({ halt: approval }).samples).toBe(11);
    expect(metrics.rate(approvals, { facets: [Category.of('billing')] })).toEqual({ rate: 9 / 11, hits: 9, samples: 11 });
    expect(metrics.rate(approvals, { facets: [Category.of('refund')] })).toEqual({ rate: 0, hits: 0, samples: 0 });
    expect(metrics.paused({ lane: audits }).count).toBe(1);
    expect(metrics.outcomes({ of: Conversation })).toMatchObject({ terminal: 11, success: 9, failure: 2, samples: 11 });
    expect(metrics.outcomes({ of: Conversation }).count(Rejected)).toBe(2);
    expect(metrics.attempts({ of: conversations })).toMatchObject({ succeeded: 11, failed: 0, samples: 11 });
    await rt.stop();
  });
});
