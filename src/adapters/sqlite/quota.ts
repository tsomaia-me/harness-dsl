import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { and, asc, eq, gte, inArray } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { QuotaEvent, QuotaPartition } from '../../kernel/quota.js';
import { parseWithDates, stringifyWithDates } from '../json-dates.js';
import { quotaEvents, quotaMembers } from './quota-schema.js';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../drizzle-quota', import.meta.url));

export class SqliteQuotaPartition implements QuotaPartition {
  public readonly name: string;
  public readonly path: string;
  private readonly sqlite: Database.Database;
  private readonly db: BetterSQLite3Database;

  public constructor(name: string, options: { readonly path: string }) {
    this.name = name;
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

  public async join(harness: string, holder: string, ttlMs: number): Promise<{ readonly accepted: boolean; readonly heldBy?: string }> {
    const now = Date.now();
    return this.sqlite.transaction(() => {
      const row = this.db.select().from(quotaMembers).where(eq(quotaMembers.harness, harness)).get();
      if (row && row.holder !== holder && row.expiresAtMs > now) return { accepted: false, heldBy: row.holder };
      this.db
        .insert(quotaMembers)
        .values({ harness, holder, expiresAtMs: now + ttlMs })
        .onConflictDoUpdate({ target: quotaMembers.harness, set: { holder, expiresAtMs: now + ttlMs } })
        .run();
      return { accepted: true };
    })();
  }

  public async append(events: readonly QuotaEvent[]): Promise<void> {
    this.sqlite.transaction(() => {
      for (const event of events) {
        this.db.insert(quotaEvents).values({ type: event.type, account: event.account, harness: event.harness, atMs: event.at.getTime(), payload: stringifyWithDates(event) }).run();
      }
    })();
  }

  public async *read(query: { readonly accounts: readonly string[]; readonly since: Date }): AsyncIterable<QuotaEvent> {
    if (query.accounts.length === 0) return;
    const rows = this.db
      .select()
      .from(quotaEvents)
      .where(and(inArray(quotaEvents.account, [...query.accounts]), gte(quotaEvents.atMs, query.since.getTime())))
      .orderBy(asc(quotaEvents.seq))
      .all();
    for (const row of rows) yield parseWithDates<QuotaEvent>(row.payload);
  }
}

export function quota(name: string, options: { readonly path: string }): SqliteQuotaPartition {
  return new SqliteQuotaPartition(name, options);
}
