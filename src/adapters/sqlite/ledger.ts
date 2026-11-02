import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { and, asc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type {
  DueTimer,
  Ledger,
  LedgerEvent,
  LedgerQuery,
  LeaseMode,
  LoopRecord,
  Position,
  SequencedEvent,
  StoredUnit,
  UnitQuery,
  UnitRecord,
  Verdict,
  WriterClaim,
} from '../../kernel/index.js';
import type { Json, JsonObject } from '../../kernel/refs.js';
import { leases, ledgerEvents, loops, stepOutputs, timers, units, writer as writerTable } from './ledger-schema.js';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../drizzle-ledger', import.meta.url));
const WRITER_ROW = 'writer';
const READ_PAGE = 500;

export class LedgerWriterError extends Error {
  public constructor(writer: string, holder: string | undefined) {
    super(holder === undefined ? `"${writer}" holds no writer claim on this ledger` : `"${writer}" is not the ledger's writer; "${holder}" holds the claim`);
    this.name = 'LedgerWriterError';
  }
}

export interface SqliteLedgerOptions {
  readonly path: string;
}

type UnitRow = typeof units.$inferSelect;

function stepAddress(step: string, iteration: number): string {
  return `${step}@${iteration}`;
}

function serializeEvent(event: LedgerEvent): string {
  return JSON.stringify(event, function (this: Record<string, unknown>, key: string, value: unknown) {
    const raw = this[key];
    return raw instanceof Date ? { $date: raw.toISOString() } : value;
  });
}

function deserializeEvent(payload: string): LedgerEvent {
  return JSON.parse(payload, (_key, value: unknown) =>
    typeof value === 'object' && value !== null && '$date' in value && typeof (value as { $date: unknown }).$date === 'string'
      ? new Date((value as { $date: string }).$date)
      : value,
  ) as LedgerEvent;
}

function unitIdOf(event: LedgerEvent): string | null {
  return 'unitId' in event && typeof event.unitId === 'string' ? event.unitId : null;
}

function attemptIdOf(event: LedgerEvent): string | null {
  return 'attemptId' in event && typeof event.attemptId === 'string' ? event.attemptId : null;
}

export class SqliteLedger implements Ledger {
  public readonly path: string;
  private readonly sqlite: Database.Database;
  private readonly db: BetterSQLite3Database;
  private holder: string | undefined;

  public constructor(options: SqliteLedgerOptions) {
    this.path = path.resolve(options.path);
    mkdirSync(path.dirname(this.path), { recursive: true });
    this.sqlite = new Database(this.path);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('busy_timeout = 5000');
    this.db = drizzle(this.sqlite);
    migrate(this.db, { migrationsFolder: MIGRATIONS_FOLDER });
  }

  public close(): void {
    this.sqlite.close();
  }

  public async append(events: readonly LedgerEvent[], writer: string): Promise<readonly number[]> {
    this.requireClaim(writer, Date.now());
    return this.sqlite.transaction(() => {
      const seqs: number[] = [];
      for (const event of events) {
        const inserted = this.db
          .insert(ledgerEvents)
          .values({ type: event.type, unitId: unitIdOf(event), attemptId: attemptIdOf(event), atMs: event.at.getTime(), payload: serializeEvent(event) })
          .returning({ seq: ledgerEvents.seq })
          .get();
        seqs.push(inserted.seq);
        this.fold(event);
      }
      return seqs;
    })();
  }

  public async *read(query: LedgerQuery): AsyncIterable<SequencedEvent> {
    let after = query.afterSeq ?? 0;
    while (true) {
      const conditions = [gt(ledgerEvents.seq, after)];
      if (query.unitId !== undefined) conditions.push(eq(ledgerEvents.unitId, query.unitId));
      if (query.attemptId !== undefined) conditions.push(eq(ledgerEvents.attemptId, query.attemptId));
      if (query.types !== undefined && query.types.length > 0) conditions.push(inArray(ledgerEvents.type, [...query.types]));
      if (query.since !== undefined) conditions.push(sql`${ledgerEvents.atMs} >= ${query.since.getTime()}`);
      const rows = this.db.select().from(ledgerEvents).where(and(...conditions)).orderBy(asc(ledgerEvents.seq)).limit(READ_PAGE).all();
      for (const row of rows) {
        yield { seq: row.seq, event: deserializeEvent(row.payload) };
        after = row.seq;
      }
      if (rows.length < READ_PAGE) return;
    }
  }

  public async unit(id: string): Promise<UnitRecord | undefined> {
    const row = this.db.select().from(units).where(eq(units.id, id)).get();
    return row ? this.record(row) : undefined;
  }

  public async units(query: UnitQuery): Promise<readonly UnitRecord[]> {
    const conditions = [];
    if (query.lane !== undefined) conditions.push(eq(units.lane, query.lane));
    if (query.key !== undefined) conditions.push(eq(units.key, query.key));
    if (query.position !== undefined && query.position.length > 0) conditions.push(inArray(units.position, [...query.position]));
    if (query.state !== undefined && query.state.length > 0) conditions.push(inArray(units.state, [...query.state]));
    if (query.attemptStatus !== undefined && query.attemptStatus.length > 0) conditions.push(inArray(units.attemptStatus, [...query.attemptStatus]));
    const rows = conditions.length > 0 ? this.db.select().from(units).where(and(...conditions)).all() : this.db.select().from(units).all();
    return rows.map((row) => this.record(row));
  }

  public async dueTimers(now: Date): Promise<readonly DueTimer[]> {
    return this.db
      .select()
      .from(timers)
      .where(and(eq(timers.state, 'armed'), lte(timers.fireAtMs, now.getTime())))
      .orderBy(asc(timers.fireAtMs))
      .all()
      .map((row) => ({ timerId: row.timerId, unitId: row.unitId, owner: row.owner }));
  }

  public async takeLease(attemptId: string, resource: string, mode: LeaseMode): Promise<boolean> {
    if (this.holder === undefined) throw new LedgerWriterError('(unclaimed)', undefined);
    this.requireClaim(this.holder, Date.now());
    return this.sqlite.transaction(() => {
      const holders = this.db.select().from(leases).where(eq(leases.resource, resource)).all();
      const own = holders.find((lease) => lease.attemptId === attemptId);
      if (own) return own.mode === mode || mode === 'shared';
      const others = holders.filter((lease) => lease.attemptId !== attemptId);
      const free = mode === 'exclusive' ? others.length === 0 : others.every((lease) => lease.mode === 'shared');
      if (!free) return false;
      this.db.insert(leases).values({ resource, attemptId, mode }).run();
      return true;
    })();
  }

  public async claimWriter(holder: string, ttlMs: number): Promise<WriterClaim> {
    const now = Date.now();
    const expiresAtMs = now + ttlMs;
    const claim = this.sqlite.transaction((): WriterClaim => {
      const row = this.db.select().from(writerTable).where(eq(writerTable.id, WRITER_ROW)).get();
      if (row && row.holder !== holder && row.expiresAtMs > now) {
        return { acquired: false, holder: row.holder, expiresAt: new Date(row.expiresAtMs) };
      }
      this.db
        .insert(writerTable)
        .values({ id: WRITER_ROW, holder, expiresAtMs })
        .onConflictDoUpdate({ target: writerTable.id, set: { holder, expiresAtMs } })
        .run();
      return { acquired: true, holder, expiresAt: new Date(expiresAtMs) };
    })();
    if (claim.acquired) this.holder = holder;
    return claim;
  }

  public async releaseWriter(holder: string): Promise<void> {
    this.db.delete(writerTable).where(and(eq(writerTable.id, WRITER_ROW), eq(writerTable.holder, holder))).run();
    if (this.holder === holder) this.holder = undefined;
  }

  private requireClaim(writer: string, nowMs: number): void {
    const row = this.db.select().from(writerTable).where(eq(writerTable.id, WRITER_ROW)).get();
    if (!row || row.expiresAtMs <= nowMs) throw new LedgerWriterError(writer, undefined);
    if (row.holder !== writer) throw new LedgerWriterError(writer, row.holder);
  }

  private record(row: UnitRow): UnitRecord {
    const outputs = row.attemptId
      ? this.db.select().from(stepOutputs).where(eq(stepOutputs.attemptId, row.attemptId)).all()
      : [];
    const loopRows = this.db.select().from(loops).where(eq(loops.unitId, row.id)).all();
    const unit: StoredUnit = {
      id: row.id,
      key: row.key,
      kind: row.kind,
      lane: row.lane,
      ...(row.parentId ? { parentId: row.parentId } : {}),
      state: row.state,
      statePosition: row.statePosition as Position,
      position: row.position as Position,
      ...(row.verdict ? { verdict: row.verdict as Verdict } : {}),
      attributes: JSON.parse(row.attributes) as JsonObject,
      createdAt: new Date(row.createdAtMs),
      costUsd: row.costUsd,
      attempts: row.attempts,
      failedAttempts: row.failedAttempts,
      ...(row.attemptId && row.attemptNumber !== null && row.attemptStatus && row.attemptStep !== null && row.attemptStartedAtMs !== null
        ? {
            attempt: {
              id: row.attemptId,
              number: row.attemptNumber,
              status: row.attemptStatus as 'running' | 'blocked',
              step: row.attemptStep,
              ...(row.blockedOn ? { blockedOn: row.blockedOn as NonNullable<StoredUnit['attempt']>['blockedOn'] } : {}),
              ...(row.halt ? { halt: row.halt } : {}),
              startedAt: new Date(row.attemptStartedAtMs),
            },
          }
        : {}),
    };
    return {
      unit,
      ...(row.cursorStep !== null && row.cursorIteration !== null && row.flowVersion !== null
        ? { cursor: { step: row.cursorStep, iteration: row.cursorIteration, flowVersion: row.flowVersion } }
        : {}),
      stepOutputs: Object.fromEntries(outputs.map((output) => [output.address, JSON.parse(output.output) as Json])),
      loops: Object.fromEntries(
        loopRows.map((loop): [string, LoopRecord] => [
          loop.loop,
          { iteration: loop.iteration, span: loop.span as LoopRecord['span'], ...(loop.carry !== null ? { carry: JSON.parse(loop.carry) as Json } : {}) },
        ]),
      ),
      ...(row.notBeforeMs !== null ? { notBefore: new Date(row.notBeforeMs) } : {}),
    };
  }

  private unitOfAttempt(attemptId: string): UnitRow | undefined {
    return this.db.select().from(units).where(eq(units.attemptId, attemptId)).get();
  }

  private fold(event: LedgerEvent): void {
    switch (event.type) {
      case 'unitCreated':
        this.db
          .insert(units)
          .values({
            id: event.unitId,
            key: event.key,
            kind: event.kind,
            lane: event.lane,
            parentId: event.parentId ?? null,
            state: '',
            statePosition: 'pending',
            position: 'pending',
            attributes: JSON.stringify(event.attributes),
            createdAtMs: event.at.getTime(),
          })
          .run();
        return;
      case 'attributesUpdated': {
        if (!event.applied) return;
        const row = this.db.select().from(units).where(eq(units.id, event.unitId)).get();
        if (!row) return;
        const merged = { ...(JSON.parse(row.attributes) as JsonObject), ...event.attributes };
        this.db.update(units).set({ attributes: JSON.stringify(merged) }).where(eq(units.id, event.unitId)).run();
        return;
      }
      case 'transition': {
        const row = this.db.select().from(units).where(eq(units.id, event.unitId)).get();
        if (!row) return;
        const position = row.attemptStatus === 'running' ? 'active' : row.attemptStatus === 'blocked' ? 'waiting' : event.position;
        this.db
          .update(units)
          .set({ state: event.to, statePosition: event.position, position, verdict: event.verdict ?? null })
          .where(eq(units.id, event.unitId))
          .run();
        if (event.position === 'terminal') {
          this.db.update(timers).set({ state: 'cleared' }).where(and(eq(timers.unitId, event.unitId), eq(timers.state, 'armed'))).run();
        }
        return;
      }
      case 'attemptStarted':
        this.db
          .update(units)
          .set({
            attemptId: event.attemptId,
            attemptNumber: event.number,
            attemptStatus: 'running',
            attemptStep: event.fromStep,
            blockedOn: null,
            halt: null,
            attemptStartedAtMs: event.at.getTime(),
            cursorStep: event.fromStep,
            cursorIteration: 0,
            flowVersion: event.flowVersion,
            notBeforeMs: null,
            position: 'active',
            attempts: sql`${units.attempts} + 1`,
          })
          .where(eq(units.id, event.unitId))
          .run();
        return;
      case 'attemptBlocked':
        this.db
          .update(units)
          .set({ attemptStatus: 'blocked', attemptStep: event.step, blockedOn: event.on, halt: event.halt ?? null, position: 'waiting' })
          .where(eq(units.attemptId, event.attemptId))
          .run();
        return;
      case 'attemptResumed':
        this.db
          .update(units)
          .set({ attemptStatus: 'running', attemptStep: event.step, blockedOn: null, halt: null, position: 'active' })
          .where(eq(units.attemptId, event.attemptId))
          .run();
        return;
      case 'attemptRewound':
        this.db.update(units).set({ cursorStep: event.to, cursorIteration: 0, attemptStep: event.to }).where(eq(units.attemptId, event.attemptId)).run();
        for (const step of event.superseded ?? []) {
          this.db.delete(stepOutputs).where(and(eq(stepOutputs.attemptId, event.attemptId), sql`${stepOutputs.address} LIKE ${`${step.replace(/[\\%_]/g, '\\$&')}@%`} ESCAPE '\\'`)).run();
        }
        return;
      case 'attemptEnded': {
        const row = this.unitOfAttempt(event.attemptId);
        if (!row) return;
        this.db
          .update(units)
          .set({
            attemptId: null,
            attemptNumber: null,
            attemptStatus: null,
            attemptStep: null,
            blockedOn: null,
            halt: null,
            attemptStartedAtMs: null,
            cursorStep: null,
            cursorIteration: null,
            flowVersion: null,
            position: row.statePosition,
            costUsd: sql`${units.costUsd} + ${event.costUsd}`,
            failedAttempts: event.outcome === 'failed' ? sql`${units.failedAttempts} + 1` : units.failedAttempts,
          })
          .where(eq(units.id, row.id))
          .run();
        this.db.delete(loops).where(and(eq(loops.unitId, row.id), eq(loops.span, 'attempt'))).run();
        this.db.delete(leases).where(eq(leases.attemptId, event.attemptId)).run();
        return;
      }
      case 'retryScheduled':
        this.db
          .update(units)
          .set({ notBeforeMs: event.notBefore.getTime(), failedAttempts: event.failedAttempts })
          .where(eq(units.id, event.unitId))
          .run();
        return;
      case 'loopIteration':
        this.db
          .insert(loops)
          .values({
            unitId: event.unitId,
            loop: event.loop,
            attemptId: event.attemptId,
            iteration: event.iteration,
            span: event.span,
            carry: event.carry === undefined ? null : JSON.stringify(event.carry),
          })
          .onConflictDoUpdate({
            target: [loops.unitId, loops.loop],
            set: { attemptId: event.attemptId, iteration: event.iteration, span: event.span, carry: event.carry === undefined ? null : JSON.stringify(event.carry) },
          })
          .run();
        return;
      case 'stepStarted':
        this.db
          .update(units)
          .set({ attemptStep: event.step, cursorStep: event.step, cursorIteration: event.iteration })
          .where(eq(units.attemptId, event.attemptId))
          .run();
        return;
      case 'stepEnded':
      case 'metricRead':
      case 'decisionRecorded': {
        const row = this.unitOfAttempt(event.attemptId);
        if (!row) return;
        const iteration = event.type === 'decisionRecorded' ? (row.cursorIteration ?? 0) : event.iteration;
        const output: Json = event.type === 'stepEnded' ? (event.output ?? null) : event.type === 'metricRead' ? { value: event.read.value, samples: event.read.samples } : event.decision;
        if (event.type === 'stepEnded' && !event.ok) return;
        this.db
          .insert(stepOutputs)
          .values({ attemptId: event.attemptId, address: stepAddress(event.step, iteration), unitId: row.id, output: JSON.stringify(output) })
          .onConflictDoUpdate({ target: [stepOutputs.attemptId, stepOutputs.address], set: { output: JSON.stringify(output) } })
          .run();
        return;
      }
      case 'timerSet':
        this.db
          .insert(timers)
          .values({ timerId: event.timerId, unitId: event.unitId, owner: event.owner, fireAtMs: event.fireAt.getTime(), state: 'armed' })
          .onConflictDoUpdate({ target: timers.timerId, set: { fireAtMs: event.fireAt.getTime(), state: 'armed', owner: event.owner } })
          .run();
        return;
      case 'timerCleared':
        this.db.update(timers).set({ state: 'cleared' }).where(eq(timers.timerId, event.timerId)).run();
        return;
      case 'timerFired':
        this.db.update(timers).set({ state: 'fired' }).where(eq(timers.timerId, event.timerId)).run();
        return;
      case 'leaseTaken':
        this.db.insert(leases).values({ resource: event.resource, attemptId: event.attemptId, mode: event.mode }).onConflictDoNothing().run();
        return;
      case 'leaseReleased':
        this.db.delete(leases).where(and(eq(leases.resource, event.resource), eq(leases.attemptId, event.attemptId))).run();
        return;
      default:
        return;
    }
  }
}

export const sqlite = {
  ledger(options: SqliteLedgerOptions): SqliteLedger {
    return new SqliteLedger(options);
  },
};
