# Harness DSL (`harness-dsl`) — Technical Design Document

## §1. Package Layout & Dependencies

### §1.1 Directory Structure

```text
/Users/torniketsomaia/projects/harness-dsl/
  package.json
  tsconfig.json
  vitest.config.ts
  PRODUCT_SPEC.md
  TECH_DESIGN.md
  src/
    index.ts                # Public exports: `H` namespace, Zod re-export, core types
    types.ts                # Core interfaces: Executable, Driver, AccountProvider, FlowContext, etc.
    dsl.ts                  # Immutable fluent builders for H.account, H.pool, H.model, H.runner, H.command, H.skill, H.agent, H.flow, H.head
    schema.ts               # Drizzle ORM SQLite schema definitions
    store.ts                # SQLite repository + lessons.jsonl CRUD + BOARD.md & TELEMETRY.md projections
    quota.ts                # Account & Pool reactive quota engine, maxQuotaShare math, and rotation strategies
    runner.ts               # Local & Agentless SSH (ControlMaster + setsid process-group) command runner
    engine.ts               # Deterministic H.flow execution engine (step, when, branch, parallel, loop, batch, haltIf)
    mcp.ts                  # HTTP server hosting @modelcontextprotocol/sdk (Head tools) + /internal/hook receiver
    drivers/
      index.ts              # H.drivers.* factory exports
      claude-cli.ts         # Claude Code CLI (`claude -p --output-format stream-json --json-schema`) driver
      ai-sdk.ts             # Vercel AI SDK (`ai` + @ai-sdk/anthropic, @ai-sdk/google, @ai-sdk/openai) + Cloud Batch API driver
      custom.ts             # User-supplied function / command driver wrapper
      mock.ts               # Deterministic in-memory driver for unit & failure-injection tests
    plugins/
      index.ts              # Public plugin exports (`harness-dsl/plugins`)
      worktree.ts           # gitWorktreeIsolation() middleware using simple-git
      file-lease.ts         # fileLeaseGuard() PreToolUse hook plugin using picomatch
      stop-command.ts       # stopCommandHook() Stop hook plugin
  test/
    unit/                   # Fast deterministic unit & break-once tests (<3s, $0)
    e2e/                    # Live E2E tests against real CLI subscriptions, API keys, temp git repos, and MCP
```

### §1.2 Dependencies (`package.json`)

The framework delegates generic infrastructure concerns to maintained MIT/Apache-2.0 libraries:

```json
{
  "name": "harness-dsl",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./dist/index.js",
    "./plugins": "./dist/plugins/index.js"
  },
  "dependencies": {
    "@ai-sdk/anthropic": "^3.0.0",
    "@ai-sdk/google": "^3.0.0",
    "@ai-sdk/openai": "^3.0.0",
    "@modelcontextprotocol/sdk": "^1.25.0",
    "ai": "^6.0.0",
    "async-mutex": "^0.5.0",
    "better-sqlite3": "^12.0.0",
    "chokidar": "^5.0.0",
    "croner": "^10.0.0",
    "drizzle-orm": "^0.45.0",
    "execa": "^9.6.0",
    "gray-matter": "^4.0.3",
    "p-queue": "^9.0.0",
    "p-retry": "^7.0.0",
    "picomatch": "^4.0.3",
    "simple-git": "^3.30.0",
    "tree-kill": "^1.2.2",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^22.19.0",
    "@types/tree-kill": "^1.2.7",
    "typescript": "^5.9.0",
    "vitest": "^4.0.0"
  }
}
```

---

## §2. Core TypeScript Interfaces (`src/types.ts`)

### §2.1 `Executable<TInput, TOutput>`

Every runnable descriptor (`CommandDef`, `BoundAgentSkill`, `FlowDef`) implements `Executable`:

```typescript
import type { z } from 'zod';

export interface ExecutionContext {
  readonly runId: string;
  readonly projectDir: string;
  readonly workDir: string;
  readonly slotIndex: number;
  readonly slotPorts: readonly number[];
  readonly store: HarnessStore;
  readonly signal: AbortSignal;
}

export interface Executable<TInput = unknown, TOutput = unknown> {
  readonly kind: 'command' | 'agent-skill' | 'flow' | 'batch';
  readonly name: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly outputSchema: z.ZodType<TOutput>;
  execute(input: TInput, ctx: ExecutionContext): Promise<TOutput>;
}
```

### §2.2 `AccountProvider`, `Driver`, and `QuotaSnapshot`

```typescript
export interface QuotaSnapshot {
  readonly utilization5h: number;      // 0.0 to 1.0
  readonly utilization7d: number;      // 0.0 to 1.0
  readonly resets5hAtMs: number | null;
  readonly resets7dAtMs: number | null;
  readonly cooldownUntilMs: number | null;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly actualCostUsd: number;
  readonly equivalentCostUsd: number;
}

export interface DriverInvokeRequest {
  readonly accountId: string;
  readonly modelId: string;
  readonly modelOptions: Record<string, unknown>;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly outputJsonSchema: Record<string, unknown>;
  readonly workDir: string;
  readonly allowedTools?: readonly string[];
  readonly maxContextTokens?: number;
  readonly hookServerUrl?: string;
  readonly runId: string;
  readonly stepName: string;
  readonly sessionId?: string;
  readonly inactivityTimeoutMs: number;
  readonly signal: AbortSignal;
}

export interface DriverInvokeResult {
  readonly structuredOutput: unknown;
  readonly rawText: string;
  readonly sessionId: string;
  readonly usage: TokenUsage;
  readonly handoffRequested?: {
    summary: string;
    remainingWork: string[];
  };
  readonly quotaHint?: Partial<QuotaSnapshot>;
}

export interface BatchItemRequest {
  readonly customId: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly outputJsonSchema: Record<string, unknown>;
}

export interface BatchItemResult {
  readonly customId: string;
  readonly ok: boolean;
  readonly structuredOutput?: unknown;
  readonly error?: string;
  readonly usage: TokenUsage;
}

export interface BatchAdapter {
  submit(items: readonly BatchItemRequest[], modelId: string, opts: Record<string, unknown>): Promise<{ batchId: string }>;
  poll(batchId: string): Promise<{
    status: 'running' | 'completed' | 'failed';
    results?: readonly BatchItemResult[];
  }>;
  cancel?(batchId: string): Promise<void>;
}

export interface Driver {
  readonly kind: 'claude-cli' | 'ai-sdk' | 'custom' | 'mock';
  invoke(req: DriverInvokeRequest): Promise<DriverInvokeResult>;
  probeQuota?(accountId: string): Promise<Partial<QuotaSnapshot>>;
  readonly batch?: BatchAdapter;
}

export interface ResolvedAccount {
  readonly accountId: string;
  readonly driver: Driver;
  readonly maxQuotaShare: number;
}

export interface AccountProvider {
  readonly id: string;
  readonly maxQuotaShareValue: number;
  maxQuotaShare(ratio: number): this;
  acquireAccount(store: HarnessStore): Promise<ResolvedAccount>;
}
```

---

## §3. SQLite Schema (`src/schema.ts`)

State is persisted in `<projectDir>/.harness/runtime.db` using `better-sqlite3` in `WAL` mode (`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;`) and `drizzle-orm/better-sqlite3`.

```typescript
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const workflowRuns = sqliteTable('workflow_runs', {
  id: text('id').primaryKey(),
  flowName: text('flow_name').notNull(),
  ticketId: text('ticket_id'),
  status: text('status').$type<'queued' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled'>().notNull(),
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
```

---

## §4. Account Pool & Reactive Quota Engine (`src/quota.ts`)

### §4.1 Quota Eligibility Check

When `pool.acquireAccount(store)` is called:

1. **Refresh Expired Windows:** For each member `account`, if `now >= resets5hAtMs`, reset `utilization5h = 0`; if `now >= resets7dAtMs`, reset `utilization7d = 0` and `projectShareUsed = 0`; if `now >= cooldownUntilMs`, clear `cooldownUntilMs = null`.
2. **Optional Probe:** If `account.driver.probeQuota` exists and `now - updatedAtMs > 60_000`, call `probeQuota(account.id)` and merge the returned snapshot into `account_quotas`.
3. **Effective Cap Calculation:**
   `effectiveShareCap = Math.min(account.maxQuotaShareValue, pool.maxQuotaShareValue)`
4. **Filter Eligible Accounts:** An account is eligible if and only if:
   - `cooldownUntilMs === null || cooldownUntilMs <= now`
   - `projectShareUsed < effectiveShareCap`
   - `utilization5h < 0.95` and `utilization7d < 0.98`
5. **Apply Reserve Rule:** If `pool.reserve` specifies `{ minFreeAccounts, maxBurstUtilization }`, ensure at least `minFreeAccounts` remain below `maxBurstUtilization` unless no other account is available.
6. **Sort by Strategy:**
   - `'drain-soonest-expiring'`: Sort ascending by `resets7dAtMs ?? Infinity`, breaking ties by `utilization5h ASC`.
   - `'least-used'`: Sort ascending by `Math.max(utilization5h, projectShareUsed)`.
   - `'priority'`: Keep declaration order.
   - `'round-robin'`: Sort ascending by `updatedAtMs`.
7. **Fallback:** If zero pool accounts are eligible and `pool.fallbackAccount` is configured, return `pool.fallbackAccount.acquireAccount(store)`. Otherwise, if an account's `cooldownUntilMs` or `resets5hAtMs` is known, throw a typed `QuotaExhaustedError(nextAvailableAtMs)`.

### §4.2 Reactive Rate-Limit & Header Parsing

Whenever any driver receives a response or a `429` rate-limit error:
- If HTTP headers include `anthropic-ratelimit-unified-5h-utilization`, `anthropic-ratelimit-unified-7d-utilization`, or `retry-after`, update `account_quotas` immediately.
- If `claude -p` emits a rate-limit error event containing a reset timestamp, parse the timestamp into `cooldownUntilMs` and retry the invocation automatically on the next eligible account in the pool.

---

## §5. Driver Implementations (`src/drivers/`)

### §5.1 Claude CLI Driver (`src/drivers/claude-cli.ts`)

Spawns the `claude` CLI in non-interactive streaming mode using `execa`.

1. **Ephemeral Hook Settings Generation:**
   Writes `/tmp/harness-settings-<runId>-<stepName>.json` containing only the internal hook endpoints for that specific step:
   ```json
   {
     "hooks": {
       "PreToolUse": [{
         "matcher": "Edit|Write",
         "hooks": [{ "type": "command", "command": "curl -sS -X POST http://127.0.0.1:<port>/internal/hook?event=PreToolUse&runId=<runId> -d @-" }]
       }],
       "Stop": [{
         "hooks": [{ "type": "command", "command": "curl -sS -X POST http://127.0.0.1:<port>/internal/hook?event=Stop&runId=<runId> -d @-" }]
       }]
     }
   }
   ```
2. **CLI Arguments:**
   ```bash
   claude -p \
     --model <modelId> \
     --session-id <sessionId> \
     --output-format stream-json \
     --verbose \
     --json-schema '<JSON.stringify(req.outputJsonSchema)>' \
     --settings /tmp/harness-settings-<runId>-<stepName>.json \
     --append-system-prompt "<req.systemPrompt + filteredLessons>" \
     --allowedTools "<req.allowedTools.join(',')>" \
     --strict-mcp-config \
     "<req.userPrompt>"
   ```
   Environment includes `{ ...process.env, CLAUDE_CONFIG_DIR: configDir }`.
3. **Real-Time Stream Monitoring (`stdout` line-by-line JSONL):**
   - Resets the `inactivityTimeoutMs` watchdog timer on every JSONL line. If the timer fires, kills the process tree via `treeKill(child.pid, 'SIGKILL')` and throws `InactivityTimeoutError`.
   - Reads `entry.message?.usage` on every assistant message:
     `totalContext = input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens`.
   - **Context Ceiling Guard:** If `req.maxContextTokens` is set and `totalContext >= req.maxContextTokens - 30_000`, flags the run for handoff: once the current turn finishes (or by resuming with a 1-turn handoff prompt), captures `{ summary, remainingWork }` and spawns a fresh session on the same `workDir` with the handoff summary.
   - Extracts the final `result` event's `structured_output` (or parses the final assistant JSON block).

### §5.2 AI SDK & Cloud Batch Driver (`src/drivers/ai-sdk.ts`)

1. **Real-Time Calls:**
   Uses Vercel AI SDK's `generateText` / `Output.object({ schema })` across `@ai-sdk/anthropic`, `@ai-sdk/google`, and `@ai-sdk/openai`. When `cachePrefix: true` is set on an Anthropic model, attaches `providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } }` to the system message.
2. **Cloud Batch Adapter (`batch`):**
   - For `provider === 'anthropic'`: Submits batch items to `POST https://api.anthropic.com/v1/messages/batches` with `output_config.format` (or single tool schema) matching `outputJsonSchema` and ephemeral cache markers on shared system prompts. Polls `GET /v1/messages/batches/:id` and streams `.results_url` JSONL on completion.
   - For `provider === 'google'` / `'openai'`: Uses the respective Batch API endpoints, or falls back to bounded local concurrency via `p-queue` if `useCloudBatch: false`.

### §5.3 Schema Validation & Self-Correction Loop

In `BoundAgentSkill.execute(input, ctx)`:
1. Validate `input` with `skill.inputSchema.parse(input)`.
2. Convert `skill.outputSchema` to JSON Schema using Zod v4's `z.toJSONSchema(skill.outputSchema)`.
3. Invoke the model driver.
4. Parse `result.structuredOutput` with `skill.outputSchema.safeParse(...)` and run `skill.assertFn?.(parsed.data, input)`.
5. If validation or `.assert()` fails and `attempt <= skill.maxRetriesCount`:
   Re-invoke with the validation error message appended so the model repairs its output.

---

## §6. Local & Agentless SSH Runner Engine (`src/runner.ts`)

### §6.1 Concurrency Slots & Port Ranges

Each `Runner` instance holds a `PQueue({ concurrency: maxConcurrentSlots })` and a free-slot bitmask `[0 .. maxConcurrentSlots - 1]`.
When a job acquires slot `k`:
- `slotPorts` are `[slotPortBase + k * 10, ..., slotPortBase + k * 10 + 9]`.
- Injected into command environment as `HARNESS_SLOT=k`, `PORT=${slotPorts[0]}`, `PORT_API=${slotPorts[0]}`, `PORT_WEB=${slotPorts[1]}`, `PORT_ADMIN=${slotPorts[2]}`.

### §6.2 Agentless SSH Execution & Process-Group Containment

For `H.runner.ssh(id, opts)`:
1. **ControlMaster Socket:** Uses `-o ControlMaster=auto -o ControlPath=~/.harness/ssh-%r@%h:%p.sock -o ControlPersist=10m -o ServerAliveInterval=5 -o ServerAliveCountMax=2`.
2. **Pre-Flight Health Check:** Runs a single fast command over the muxed socket to check `/proc/loadavg` (on Linux) or `sysctl -n vm.loadavg` and `df -Pk <workDir>`. If disk is below `minFreeDiskGb`, throws `RunnerDiskLowError`.
3. **Git Sync Over LAN:** When syncing a local worktree commit `<sha>` to the remote runner, runs:
   `git -C <localWorkDir> push -f ssh://<host><remoteWorkDir> <sha>:refs/harness/slot-<k>`
4. **Zero-Orphan Process Group Wrapper:**
   Every remote command is executed inside a self-cleaning process group:
   ```bash
   ssh <muxFlags> <host> "setsid bash -c '
     trap \"kill -TERM -\$\$ 2>/dev/null; sleep 0.2; kill -KILL -\$\$ 2>/dev/null\" EXIT INT TERM HUP
     cd <remoteWorkDir> && <command>
   '"
   ```
   If the local orchestrator aborts the `execa` call, times out, or loses the SSH connection, `sshd` closes the pipe, triggering `HUP`/`EXIT` inside the `setsid` leader, which immediately kills `-$$` (every child process spawned by the job on `wb`/`wb2`).

---

## §7. Flow Execution Engine (`src/engine.ts`)

`FlowEngine.run(flowDef, rawInput, opts)` executes the declarative AST of `FlowStepNode`s:

1. **Initialization:**
   - Validates `rawInput` against `flowDef.inputSchema`.
   - Inserts a `workflow_runs` row with status `'running'` and triggers `store.projectBoard()`.
   - Runs any attached flow middlewares (`flowDef.middlewares`, such as `gitWorktreeIsolation`), which wrap the execution in a `try / finally` block.
2. **Node Execution:**
   - `step`: Maps `ctx` through `inputMapper`, calls `executable.execute(mappedInput, execCtx)`, stores result at `ctx.steps[step.name]`, persists `stateJson` in `workflow_runs`, and updates `BOARD.md`.
   - `when`: Evaluates `predicate(ctx)`. If true, executes the inner node/subflow.
   - `branch`: Evaluates `selector(ctx)` and executes the matching branch node.
   - `parallel`: Executes all branches via `Promise.all()`, assigning each output to `ctx.steps[key]`.
   - `loop`: Loops `iteration = 0 .. maxIterations - 1`. At the end of each iteration, evaluates `until(ctx)`. If true, breaks out of the loop. Otherwise copies `ctx.steps` to `ctx.prev` and starts the next iteration. If `maxIterations` is exhausted without `until(ctx)` returning true, halts as `'blocked'` (or throws `MaxIterationsReachedError` if configured).
   - `batch`: Resolves `items(ctx)`. If the target `Executable` uses a `Driver` with a `batch` adapter and `items.length > 1`, submits via `driver.batch.submit()` and polls to completion; otherwise maps items through `PQueue({ concurrency })`.
   - `haltIf`: Evaluates `predicate(ctx)`. If true:
     - Updates `workflow_runs.status = 'blocked'` and `blockerReason`.
     - Projects `BOARD.md` and pushes a notification to `Head`.
     - Awaits an in-memory `Deferred` promise keyed by `runId` that resolves when `Head` (or the CLI) calls `store.resolveBlocker(runId, resolution)`.
     - Stores `resolution` in `ctx.resolutions` and continues to the next step.
3. **Completion:**
   - Marks `workflow_runs.status = 'completed'`, records `finishedAtMs`, and projects both `.harness/BOARD.md` and `.harness/TELEMETRY.md`.

---

## §8. MCP Server, `Head` Bridge, and Hook Receiver (`src/mcp.ts`)

The orchestrator starts an HTTP server on `127.0.0.1:<port>` (default `4100`, auto-incrementing if busy) and writes `<projectDir>/.mcp.json`:

```json
{
  "mcpServers": {
    "harness": {
      "type": "http",
      "url": "http://127.0.0.1:4100/mcp"
    }
  }
}
```

### §8.1 MCP Endpoints (`/mcp`)

Uses `McpServer` and `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk`:
- Always registers `harness_ground` and `harness_handoff`.
- Conditionally registers tools based on `headDef.capabilities`:
  - `'workflows:read'` → `workflow_status`, `workflow_inspect_run`
  - `'workflows:control'` → `workflow_start`, `workflow_cancel`, `workflow_pause`
  - `'tickets:read'` / `'tickets:write'` → `ticket_list`, `ticket_read`, `ticket_write`
  - `'blockers:resolve'` → `blocker_list`, `blocker_resolve`
  - `'lessons:manage'` → `lesson_list`, `lesson_add`, `lesson_widen`, `lesson_remove`
  - `'accounts:manage'` → `account_status`, `account_set_share`
  - `'telemetry:read'` → `telemetry_summary`, `telemetry_runs`
- Registers every custom tool attached via `head.tool(name, executable)` by converting `executable.inputSchema` into the MCP tool schema and wiring the handler directly to `executable.execute(args, execCtx)`.

### §8.2 Internal Hook Receiver (`POST /internal/hook`)

Handles Claude Code hook callbacks from both workflow agents and `Head`:
1. **`Head` Context Tracking:** When `session_id` matches the active `Head` session and `transcript_path` is present, reads the tail 64 KB of `transcript_path`, sums the last turn's token usage, updates `head_sessions.contextTokens`, and if `contextTokens >= headDef.contextNoticeThreshold`, returns `additionalContext` instructing `Head` to call `harness_handoff`.
2. **`PreToolUse` (`fileLeaseGuard` plugin):** Checks `tool_input.file_path` against `file_leases` in SQLite using `picomatch`. If no other run holds a lease on the file, acquires the lease for `runId` and allows the tool call; if another run holds the lease, returns `{ permissionDecision: 'deny', permissionDecisionReason: '...' }`.
3. **`Stop` (`stopCommandHook` plugin):** Runs the configured `H.command` (e.g. `TouchedChecks`). If `passed === false`, returns `{ decision: 'block', reason: summary }` so the Builder fixes the issue inside the same turn.

---

## §9. Verification & End-to-End Test Plan

### §9.1 Unit & Failure-Injection Suite (`test/unit/`)
Run via `pnpm test`:
1. **`dsl-types.test.ts`:** Verifies compile-time and runtime type propagation across `.step()`, `.when()`, `.branch()`, `.parallel()`, `.loop()`, and `.batch()`.
2. **`quota-pool.test.ts`:** Verifies per-account `.maxQuotaShare()`, per-pool `.maxQuotaShare()`, `'drain-soonest-expiring'` ordering, reactive `429` cooldown failover, and early-reset recovery. Includes a break-once check proving an account over its share cap is never selected.
3. **`engine-combinators.test.ts`:** Tests `.loop()` convergence, dispute arbitration branching, `.haltIf()` pause and `resolveBlocker()` resume, and Zod output validation auto-retry on malformed LLM output using `H.drivers.mock()`.
4. **`plugins-and-leases.test.ts`:** Tests `fileLeaseGuard()` dynamic lease acquisition and cross-run conflict denial, `gitWorktreeIsolation()` branch creation and cleanup, and `stopCommandHook()` blocking behavior.
5. **`runner-process-cleanup.test.ts`:** Spawns a command that forks a background child process, triggers an inactivity timeout, and asserts the child PID is terminated.
6. **`store-and-projections.test.ts`:** Verifies SQLite persistence, `.harness/lessons.jsonl` role+glob filtering, and `.harness/BOARD.md` / `.harness/TELEMETRY.md` generation.

### §9.2 Live End-to-End Suite (`test/e2e/`)
Run via `node --env-file=.env pnpm test:e2e` (secrets are loaded by Node into `process.env` and never read or printed by any agent):
1. **`claude-cli-pool.e2e.test.ts`:** Executes a real `H.agent` + `H.skill` over `H.drivers.claudeCli()` using your subscription credentials, verifies strict Zod `--json-schema` compliance, verifies live token/cost telemetry in SQLite, and forces a live failover from Account 1 to Account 2 via `.maxQuotaShare()`.
2. **`ai-sdk-and-batch.e2e.test.ts`:** Executes a real `H.skill` and a 2-item `H.batch` against the SDK provider using the API key in `.env`, verifying schema validation and `actualCostUsd` accounting.
3. **`full-coding-loop.e2e.test.ts`:** Creates a temporary git repository in `/tmp`, runs a complete `Builder → Stop Hook (vitest) → Dispute Arbiter → Auditor → Merge` flow on a real broken TypeScript module, and asserts the resulting `main` branch passes tests cleanly.
4. **`mcp-head.e2e.test.ts`:** Starts the HTTP/MCP server, connects a real `@modelcontextprotocol/sdk` client, executes `harness_ground()`, invokes a custom `.tool()` (`RepoExplorer`), resolves a live `.haltIf()` blocker via `blocker_resolve`, and verifies the workflow completes.
