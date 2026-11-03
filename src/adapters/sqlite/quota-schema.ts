import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const quotaEvents = sqliteTable(
  'quota_events',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    type: text('type').notNull(),
    account: text('account').notNull(),
    harness: text('harness').notNull(),
    atMs: integer('at_ms').notNull(),
    payload: text('payload').notNull(),
  },
  (table) => [index('quota_events_account').on(table.account), index('quota_events_at').on(table.atMs)],
);

export const quotaMembers = sqliteTable('quota_members', {
  harness: text('harness').primaryKey(),
  holder: text('holder').notNull(),
  expiresAtMs: integer('expires_at_ms').notNull(),
});
