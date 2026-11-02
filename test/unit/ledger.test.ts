import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LedgerEvent } from '../../src/kernel/index.js';
import { LedgerWriterError, SqliteLedger } from '../../src/adapters/sqlite/ledger.js';

const T0 = new Date('2026-11-02T10:00:00Z');
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

function created(unitId: string, key: string, seconds = 0): LedgerEvent[] {
  return [
    { type: 'unitCreated', unitId, lane: 'bugs', kind: 'Bug', key, attributes: { title: key }, source: 'test', at: at(seconds) },
    { type: 'transition', unitId, to: 'Todo', position: 'pending', cause: 'created', at: at(seconds) },
  ];
}

function started(unitId: string, attemptId: string, number: number, seconds: number): LedgerEvent {
  return { type: 'attemptStarted', unitId, attemptId, number, fromStep: 'build', flow: 'build-audit', flowVersion: 'v1', serviceClass: 'standard', at: at(seconds) };
}

describe('SqliteLedger', () => {
  let dir: string;
  let ledger: SqliteLedger;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'harness-ledger-'));
    ledger = new SqliteLedger({ path: path.join(dir, 'ledger.sqlite') });
    await ledger.claimWriter('me', 60_000);
  });

  afterEach(() => {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function all(query: Parameters<SqliteLedger['read']>[0] = {}) {
    const out = [];
    for await (const row of ledger.read(query)) out.push(row);
    return out;
  }

  it('appends with increasing sequence numbers and reads back in order, with filters', async () => {
    const seqs = await ledger.append([...created('u1', 'BUG-1'), ...created('u2', 'BUG-2', 1)], 'me');
    expect(seqs).toEqual([1, 2, 3, 4]);
    const events = await all();
    expect(events.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
    expect(events[0]!.event.type).toBe('unitCreated');
    expect(events[0]!.event.at).toEqual(T0);
    expect((await all({ afterSeq: 2 })).map((row) => row.seq)).toEqual([3, 4]);
    expect((await all({ unitId: 'u2' })).map((row) => row.seq)).toEqual([3, 4]);
    expect((await all({ types: ['transition'] })).map((row) => row.seq)).toEqual([2, 4]);
    expect((await all({ since: at(1) })).map((row) => row.seq)).toEqual([3, 4]);
  });

  it('refuses to append without the writer claim or under another holder', async () => {
    await ledger.releaseWriter('me');
    await expect(ledger.append(created('u1', 'BUG-1'), 'me')).rejects.toBeInstanceOf(LedgerWriterError);
    await ledger.claimWriter('other', 60_000);
    await expect(ledger.append(created('u1', 'BUG-1'), 'me')).rejects.toThrow('"other" holds the claim');
    await expect(ledger.append(created('u1', 'BUG-1'), 'other')).resolves.toHaveLength(2);
  });

  it('folds a unit through creation, an attempt, steps, a block, and the end of the attempt', async () => {
    await ledger.append(created('u1', 'BUG-1'), 'me');
    let record = (await ledger.unit('u1'))!;
    expect(record.unit).toMatchObject({ key: 'BUG-1', kind: 'Bug', lane: 'bugs', state: 'Todo', position: 'pending', attempts: 0, failedAttempts: 0 });
    expect(record.unit.attempt).toBeUndefined();

    await ledger.append(
      [
        started('u1', 'a1', 1, 10),
        { type: 'stepStarted', attemptId: 'a1', step: 'build', iteration: 0, at: at(10) },
        { type: 'stepEnded', attemptId: 'a1', step: 'build', iteration: 0, ok: true, output: { summary: 'done' }, durationMs: 5, at: at(20) },
        { type: 'stepStarted', attemptId: 'a1', step: 'approval', iteration: 0, at: at(20) },
        { type: 'attemptBlocked', attemptId: 'a1', step: 'approval', on: 'decision', halt: 'owner-decision', at: at(21) },
      ],
      'me',
    );
    record = (await ledger.unit('u1'))!;
    expect(record.unit.position).toBe('waiting');
    expect(record.unit.attempts).toBe(1);
    expect(record.unit.attempt).toMatchObject({ id: 'a1', number: 1, status: 'blocked', step: 'approval', blockedOn: 'decision', halt: 'owner-decision' });
    expect(record.cursor).toEqual({ step: 'approval', iteration: 0, flowVersion: 'v1' });
    expect(record.stepOutputs).toEqual({ 'build@0': { summary: 'done' } });
    expect((await ledger.units({ attemptStatus: ['blocked'] })).map((row) => row.unit.id)).toEqual(['u1']);
    expect((await ledger.units({ position: ['active'] }))).toHaveLength(0);

    await ledger.append(
      [
        { type: 'decisionRecorded', attemptId: 'a1', step: 'approval', halt: 'owner-decision', decision: { approved: true }, resolvedBy: 'human', by: 'owner', at: at(30) },
        { type: 'attemptResumed', attemptId: 'a1', step: 'approval', at: at(30) },
        { type: 'attemptEnded', attemptId: 'a1', outcome: 'succeeded', exit: 'done', costUsd: 1.25, at: at(40) },
        { type: 'transition', unitId: 'u1', from: 'Todo', to: 'Done', position: 'terminal', verdict: 'success', attemptId: 'a1', cause: 'exit:done', at: at(40) },
      ],
      'me',
    );
    record = (await ledger.unit('u1'))!;
    expect(record.unit).toMatchObject({ state: 'Done', position: 'terminal', verdict: 'success', costUsd: 1.25, attempts: 1, failedAttempts: 0 });
    expect(record.unit.attempt).toBeUndefined();
    expect(record.cursor).toBeUndefined();
    expect(record.stepOutputs).toEqual({});
  });

  it('keeps a running attempt active across a transition and derives the state position after it ends', async () => {
    await ledger.append([...created('u1', 'BUG-1'), started('u1', 'a1', 1, 1)], 'me');
    await ledger.append([{ type: 'transition', unitId: 'u1', from: 'Todo', to: 'Working', position: 'pending', cause: 'reaction', at: at(2) }], 'me');
    expect((await ledger.unit('u1'))!.unit.position).toBe('active');
    await ledger.append([{ type: 'attemptEnded', attemptId: 'a1', outcome: 'failed', costUsd: 0, at: at(3) }], 'me');
    const record = (await ledger.unit('u1'))!;
    expect(record.unit.position).toBe('pending');
    expect(record.unit.failedAttempts).toBe(1);
  });

  it('records retries, loop iterations with carries, and keeps unit-span loops across attempts', async () => {
    await ledger.append([...created('u1', 'BUG-1'), started('u1', 'a1', 1, 1)], 'me');
    await ledger.append(
      [
        { type: 'loopIteration', unitId: 'u1', attemptId: 'a1', loop: 'rounds', iteration: 2, span: 'attempt', carry: { deficits: ['x'] }, at: at(2) },
        { type: 'loopIteration', unitId: 'u1', attemptId: 'a1', loop: 'returns', iteration: 1, span: 'unit', carry: { notes: ['n1'] }, at: at(2) },
        { type: 'attemptEnded', attemptId: 'a1', outcome: 'failed', costUsd: 0.5, at: at(3) },
        { type: 'retryScheduled', unitId: 'u1', failedAttempts: 1, notBefore: at(60), at: at(3) },
      ],
      'me',
    );
    const record = (await ledger.unit('u1'))!;
    expect(record.notBefore).toEqual(at(60));
    expect(record.unit.failedAttempts).toBe(1);
    expect(record.loops).toEqual({ returns: { iteration: 1, span: 'unit', carry: { notes: ['n1'] } } });
    await ledger.append([started('u1', 'a2', 2, 61)], 'me');
    const next = (await ledger.unit('u1'))!;
    expect(next.notBefore).toBeUndefined();
    expect(next.loops.returns).toEqual({ iteration: 1, span: 'unit', carry: { notes: ['n1'] } });
    expect(next.unit.attempt?.number).toBe(2);
  });

  it('applies attribute patches only when applied, and rewinds move the cursor', async () => {
    await ledger.append([...created('u1', 'BUG-1'), started('u1', 'a1', 1, 1)], 'me');
    await ledger.append(
      [
        { type: 'attributesUpdated', unitId: 'u1', attributes: { title: 'deferred' }, by: 'webhook', applied: false, at: at(2) },
        { type: 'attributesUpdated', unitId: 'u1', attributes: { redlines: ['r1'] }, by: 'webhook', applied: true, at: at(2) },
        { type: 'stepStarted', attemptId: 'a1', step: 'counsel', iteration: 0, at: at(3) },
        { type: 'attemptRewound', attemptId: 'a1', from: 'counsel', to: 'draft', signal: 'redline', at: at(4) },
      ],
      'me',
    );
    const record = (await ledger.unit('u1'))!;
    expect(record.unit.attributes).toEqual({ title: 'BUG-1', redlines: ['r1'] });
    expect(record.cursor).toEqual({ step: 'draft', iteration: 0, flowVersion: 'v1' });
    expect(record.unit.attempt?.step).toBe('draft');
  });

  it('tracks timers through set, moved, cleared, fired and unit termination', async () => {
    await ledger.append([...created('u1', 'BUG-1'), ...created('u2', 'BUG-2')], 'me');
    await ledger.append(
      [
        { type: 'timerSet', timerId: 't1', unitId: 'u1', owner: 'sla', fireAt: at(100), reason: 'armed', at: at(1) },
        { type: 'timerSet', timerId: 't2', unitId: 'u2', owner: 'sla', fireAt: at(50), reason: 'armed', at: at(1) },
        { type: 'timerSet', timerId: 't1', unitId: 'u1', owner: 'sla', fireAt: at(200), reason: 'moved', previousFireAt: at(100), at: at(2) },
      ],
      'me',
    );
    expect(await ledger.dueTimers(at(120))).toEqual([{ timerId: 't2', unitId: 'u2', owner: 'sla' }]);
    expect(await ledger.dueTimers(at(250))).toEqual([
      { timerId: 't2', unitId: 'u2', owner: 'sla' },
      { timerId: 't1', unitId: 'u1', owner: 'sla' },
    ]);
    await ledger.append([{ type: 'timerFired', timerId: 't2', unitId: 'u2', at: at(51) }], 'me');
    expect(await ledger.dueTimers(at(250))).toEqual([{ timerId: 't1', unitId: 'u1', owner: 'sla' }]);
    await ledger.append([{ type: 'transition', unitId: 'u1', from: 'Todo', to: 'Done', position: 'terminal', verdict: 'success', cause: 'exit', at: at(60) }], 'me');
    expect(await ledger.dueTimers(at(250))).toEqual([]);
  });

  it('grants exclusive and shared leases with the documented exclusions and releases them with the attempt', async () => {
    await ledger.append([...created('u1', 'A'), started('u1', 'a1', 1, 1), ...created('u2', 'B'), started('u2', 'a2', 1, 1)], 'me');
    expect(await ledger.takeLease('a1', 'orders-db', 'shared')).toBe(true);
    expect(await ledger.takeLease('a2', 'orders-db', 'shared')).toBe(true);
    expect(await ledger.takeLease('a2', 'orders-db', 'exclusive')).toBe(false);
    await ledger.append([{ type: 'leaseReleased', attemptId: 'a2', resource: 'orders-db', at: at(2) }], 'me');
    expect(await ledger.takeLease('a2', 'orders-db', 'exclusive')).toBe(false);
    await ledger.append([{ type: 'attemptEnded', attemptId: 'a1', outcome: 'succeeded', costUsd: 0, at: at(3) }], 'me');
    expect(await ledger.takeLease('a2', 'orders-db', 'exclusive')).toBe(true);
    expect(await ledger.takeLease('a2', 'orders-db', 'exclusive')).toBe(true);
    await ledger.append([{ type: 'leaseTaken', attemptId: 'a2', resource: 'users-db', mode: 'exclusive', waitedMs: 0, at: at(4) }], 'me');
    expect(await ledger.takeLease('a1', 'users-db', 'shared')).toBe(false);
  });

  it('claims the writer once, refuses a live holder, renews, and takes over from a dead one', async () => {
    const other = new SqliteLedger({ path: ledger.path });
    try {
      const refused = await other.claimWriter('other', 60_000);
      expect(refused).toMatchObject({ acquired: false, holder: 'me' });
      await expect(other.takeLease('a1', 'x', 'exclusive')).rejects.toBeInstanceOf(LedgerWriterError);
      const renewed = await ledger.claimWriter('me', 1);
      expect(renewed.acquired).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const takeover = await other.claimWriter('other', 60_000);
      expect(takeover).toMatchObject({ acquired: true, holder: 'other' });
      await expect(ledger.append(created('u1', 'BUG-1'), 'me')).rejects.toThrow('"other" holds the claim');
      await expect(other.append(created('u1', 'BUG-1'), 'other')).resolves.toHaveLength(2);
    } finally {
      other.close();
    }
  });
});
