import { integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
  cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  actualCostUsd: real('actual_cost_usd'),
  equivalentCostUsd: real('equivalent_cost_usd'),
  status: text('status').$type<'running' | 'pass' | 'fail' | 'blocked' | 'timeout'>().notNull(),
  outputJson: text('output_json'),
  errorText: text('error_text'),
});

export const accountQuotas = sqliteTable('account_quotas', {
  accountId: text('account_id').primaryKey(),
  projectShareUsed: real('project_share_used').notNull().default(0),
  windowTokensUsed: integer('window_tokens_used').notNull().default(0),
  cooldownUntilMs: integer('cooldown_until_ms'),
  probedAtMs: integer('probed_at_ms'),
  acquiredAtMs: integer('acquired_at_ms'),
});

export const accountQuotaWindows = sqliteTable(
  'account_quota_windows',
  {
    accountId: text('account_id').notNull(),
    windowId: text('window_id').notNull(),
    utilization: real('utilization').notNull().default(0),
    resetsAtMs: integer('resets_at_ms'),
    updatedAtMs: integer('updated_at_ms').notNull(),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.windowId] })],
);

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
