import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const ledgerEvents = sqliteTable(
  'ledger_events',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    type: text('type').notNull(),
    unitId: text('unit_id'),
    attemptId: text('attempt_id'),
    atMs: integer('at_ms').notNull(),
    payload: text('payload').notNull(),
  },
  (table) => [index('ledger_events_unit').on(table.unitId), index('ledger_events_attempt').on(table.attemptId), index('ledger_events_type').on(table.type)],
);

export const units = sqliteTable('units', {
  id: text('id').primaryKey(),
  key: text('key').notNull(),
  kind: text('kind').notNull(),
  lane: text('lane').notNull(),
  parentId: text('parent_id'),
  state: text('state').notNull(),
  statePosition: text('state_position').notNull(),
  position: text('position').notNull(),
  verdict: text('verdict'),
  attributes: text('attributes').notNull(),
  createdAtMs: integer('created_at_ms').notNull(),
  costUsd: real('cost_usd').notNull().default(0),
  attempts: integer('attempts').notNull().default(0),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  attemptId: text('attempt_id'),
  attemptNumber: integer('attempt_number'),
  attemptStatus: text('attempt_status'),
  attemptStep: text('attempt_step'),
  blockedOn: text('blocked_on'),
  halt: text('halt'),
  attemptStartedAtMs: integer('attempt_started_at_ms'),
  cursorStep: text('cursor_step'),
  cursorIteration: integer('cursor_iteration'),
  flowVersion: text('flow_version'),
  notBeforeMs: integer('not_before_ms'),
});

export const stepOutputs = sqliteTable(
  'step_outputs',
  {
    attemptId: text('attempt_id').notNull(),
    address: text('address').notNull(),
    unitId: text('unit_id').notNull(),
    output: text('output').notNull(),
  },
  (table) => [primaryKey({ columns: [table.attemptId, table.address] })],
);

export const loops = sqliteTable(
  'loops',
  {
    unitId: text('unit_id').notNull(),
    loop: text('loop').notNull(),
    attemptId: text('attempt_id').notNull(),
    iteration: integer('iteration').notNull(),
    span: text('span').notNull(),
    carry: text('carry'),
  },
  (table) => [primaryKey({ columns: [table.unitId, table.loop] })],
);

export const timers = sqliteTable('timers', {
  timerId: text('timer_id').primaryKey(),
  unitId: text('unit_id').notNull(),
  owner: text('owner').notNull(),
  fireAtMs: integer('fire_at_ms').notNull(),
  state: text('state').notNull(),
});

export const leases = sqliteTable(
  'leases',
  {
    resource: text('resource').notNull(),
    attemptId: text('attempt_id').notNull(),
    mode: text('mode').notNull(),
  },
  (table) => [primaryKey({ columns: [table.resource, table.attemptId] })],
);

export const writer = sqliteTable('writer', {
  id: text('id').primaryKey(),
  holder: text('holder').notNull(),
  expiresAtMs: integer('expires_at_ms').notNull(),
});
