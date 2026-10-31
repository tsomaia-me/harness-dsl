import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const workflowRuns = sqliteTable('workflow_runs', {
  id: text('id').primaryKey(),
  flowName: text('flow_name').notNull(),
  ticketId: text('ticket_id'),
  status: text('status')
    .$type<'queued' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled'>()
    .notNull(),
  iteration: integer('iteration').notNull().default(0),
  currentStep: text('current_step'),
  workDir: text('work_dir').notNull(),
  inputJson: text('input_json').notNull(),
  stateJson: text('state_json').notNull(),
  blockerReason: text('blocker_reason'),
  blockerResolutionJson: text('blocker_resolution_json'),
  startedAtMs: integer('started_at_ms').notNull(),
  finishedAtMs: integer('finished_at_ms'),
});

export const invocations = sqliteTable('invocations', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  iteration: integer('iteration').notNull(),
  stepName: text('step_name').notNull(),
  actorName: text('actor_name').notNull(),
  actorKind: text('actor_kind').$type<'agent' | 'command' | 'batch'>().notNull(),
  accountId: text('account_id'),
  modelId: text('model_id'),
  runnerId: text('runner_id'),
  sessionId: text('session_id'),
  startedAtMs: integer('started_at_ms').notNull(),
  finishedAtMs: integer('finished_at_ms'),
  durationMs: integer('duration_ms'),
  inputTokens: integer('input_tokens').notNull().default(0),
  cachedInputTokens: integer('cached_input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  actualCostUsd: real('actual_cost_usd').notNull().default(0),
  equivalentCostUsd: real('equivalent_cost_usd').notNull().default(0),
  status: text('status').$type<'running' | 'pass' | 'fail' | 'blocked' | 'timeout'>().notNull(),
  outputJson: text('output_json'),
  errorText: text('error_text'),
});

export const accountQuotas = sqliteTable('account_quotas', {
  accountId: text('account_id').primaryKey(),
  utilization5h: real('utilization_5h').notNull().default(0),
  utilization7d: real('utilization_7d').notNull().default(0),
  projectShareUsed: real('project_share_used').notNull().default(0),
  windowTokensUsed: integer('window_tokens_used').notNull().default(0),
  resets5hAtMs: integer('resets_5h_at_ms'),
  resets7dAtMs: integer('resets_7d_at_ms'),
  cooldownUntilMs: integer('cooldown_until_ms'),
  updatedAtMs: integer('updated_at_ms').notNull(),
});

export const fileLeases = sqliteTable('file_leases', {
  pattern: text('pattern').primaryKey(),
  runId: text('run_id').notNull(),
  acquiredAtMs: integer('acquired_at_ms').notNull(),
});

export const headSessions = sqliteTable('head_sessions', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  transcriptPath: text('transcript_path'),
  contextTokens: integer('context_tokens').notNull().default(0),
  handoffNote: text('handoff_note'),
  updatedAtMs: integer('updated_at_ms').notNull(),
});

export const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  flow_name TEXT NOT NULL,
  ticket_id TEXT,
  status TEXT NOT NULL,
  iteration INTEGER NOT NULL DEFAULT 0,
  current_step TEXT,
  work_dir TEXT NOT NULL,
  input_json TEXT NOT NULL,
  state_json TEXT NOT NULL,
  blocker_reason TEXT,
  blocker_resolution_json TEXT,
  started_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS invocations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  iteration INTEGER NOT NULL,
  step_name TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  account_id TEXT,
  model_id TEXT,
  runner_id TEXT,
  session_id TEXT,
  started_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER,
  duration_ms INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  actual_cost_usd REAL NOT NULL DEFAULT 0,
  equivalent_cost_usd REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  output_json TEXT,
  error_text TEXT
);

CREATE TABLE IF NOT EXISTS account_quotas (
  account_id TEXT PRIMARY KEY,
  utilization_5h REAL NOT NULL DEFAULT 0,
  utilization_7d REAL NOT NULL DEFAULT 0,
  project_share_used REAL NOT NULL DEFAULT 0,
  window_tokens_used INTEGER NOT NULL DEFAULT 0,
  resets_5h_at_ms INTEGER,
  resets_7d_at_ms INTEGER,
  cooldown_until_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS file_leases (
  pattern TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  acquired_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS head_sessions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  transcript_path TEXT,
  context_tokens INTEGER NOT NULL DEFAULT 0,
  handoff_note TEXT,
  updated_at_ms INTEGER NOT NULL
);
`;
