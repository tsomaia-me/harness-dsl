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
    hooks.ts                # Hook receiver path and the per-invocation endpoint URL
    defaults.ts             # Agent defaults shared by the DSL and drivers (handoff buffer, max handoffs)
    drivers/
      index.ts              # H.drivers.* factory exports
      claude-cli.ts         # Claude Code CLI (`claude -p --output-format stream-json --json-schema`) driver
      ai-sdk.ts             # Vercel AI SDK driver over a ProviderPreset
      custom.ts             # User-supplied function / command driver wrapper
      mock.ts               # Deterministic in-memory driver for unit & failure-injection tests
    presets/                # ProviderPreset per first-party AI SDK provider (anthropic, openai, google)
    rate-limits/            # RateLimitAdapter per provider (anthropic, openai, google, ietf) + Claude CLI stream events
    pricing/                # Dated price lists per provider and the price-list PricingAdapter
    batch/                  # BatchAdapter implementations (anthropic)
    protocols/              # HookProtocol implementations (claude-code) and transcript readers
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
  "version": "0.3.0",
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

The core (`types`, `dsl`, `engine`, `quota`, `store`, `mcp`, `runner`, `schema`, `hooks`) names no vendor, CLI, model, header, price, tool name, port name or input field. Every one of those lives behind one of the adapter interfaces below, with first-party implementations under `presets/`, `rate-limits/`, `pricing/`, `batch/`, `protocols/` and `drivers/`. `dsl.ts` is the composition root that wires the first-party defaults, so `H.drivers.claudeCli({ configDir })` and `H.drivers.aiSdk({ provider: 'anthropic' })` stay one-liners. `test/unit/core-boundary.test.ts` enforces this: it walks every core file's relative imports transitively (stopping at `dsl.ts`) and fails if one reaches an adapter directory or if a core or plugin file names provider vocabulary. One known exception remains until the Head-client adapter (0.4.0): `mcp.ts` writes Claude Code's project `.mcp.json`.

### §2.1 `Executable<TInput, TOutput>`

Every runnable descriptor (`CommandDef`, `BoundAgentSkill`, `FlowDef`) implements `Executable`:

```typescript
import type { z } from 'zod';

export interface ExecutionContext {
  readonly runId: string;
  readonly iteration: number;
  readonly stepName: string;
  readonly projectDir: string;
  readonly workDir: string;
  readonly touchedPaths: readonly string[];
  readonly store: HarnessStore;
  readonly hookReceiver?: HookReceiver;   // the orchestrator's MCP server, when the run has one
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

A command's slot index and ports come from the runner's `exec()` result, not from the context.

### §2.2 Quota windows and policy

```typescript
export interface QuotaWindow {
  readonly id: string;               // 'anthropic:5h', 'anthropic:7d', 'openai:requests', 'http:ratelimit', ...
  readonly utilization: number;      // 0.0 to 1.0
  readonly resetsAtMs: number | null;
}

export interface QuotaWindowPatch {
  readonly id: string;
  readonly utilization?: number;
  readonly resetsAtMs?: number | null;
}

export interface QuotaPatch {
  readonly windows?: readonly QuotaWindowPatch[];
  readonly cooldownUntilMs?: number | null;
}

export interface QuotaPolicy {
  readonly thresholds: Readonly<Record<string, number>>; // per window id
  readonly defaultThreshold: number;                       // for windows without a threshold
  readonly probeStalenessMs: number;
  readonly tokenBudget: number | null;                     // null: project share is not derived from tokens
  readonly shareResetWindowId: string | null;              // the window whose reset frees the project share
  readonly defaultCooldownMs: number;                      // a rate limit that names no reset
}
```

`DEFAULT_QUOTA_POLICY` is `{ thresholds: {}, defaultThreshold: 0.95, probeStalenessMs: 60_000, tokenBudget: null, shareResetWindowId: null, defaultCooldownMs: 60_000 }`. An account's effective policy is the core default, then its driver's `quotaPolicy`, then `H.account(...).quotaPolicy({...})`; thresholds merge per window. The Claude CLI driver supplies `{ thresholds: { 'anthropic:5h': 0.95, 'anthropic:7d': 0.98 }, tokenBudget: 5_000_000, shareResetWindowId: 'anthropic:7d' }`.

### §2.3 Usage, pricing and rate limits

```typescript
export interface TokenCounts {
  readonly inputTokens: number;          // all input, including cache reads and cache writes
  readonly cachedInputTokens: number;    // cache reads
  readonly cacheWriteTokens?: number;    // cache writes
  readonly outputTokens: number;
}

export interface TokenUsage extends TokenCounts {
  readonly actualCostUsd: number | null;      // null: the model is unpriced
  readonly equivalentCostUsd: number | null;
}

export interface PricingAdapter {
  estimate(modelId: string, usage: TokenCounts, atMs: number): number | null;
}

export interface RateLimitResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
}

export interface RateLimitAdapter {
  fromResponse(response: RateLimitResponse, nowMs: number): QuotaPatch;
}
```

Price lists price `inputTokens - cachedInputTokens - cacheWriteTokens` at the input rate, cache reads at `cachedInputPerMTok` and cache writes at `cacheWritePerMTok` (each defaults to the input rate). Pricing precedence is the same on every path, batch included: `H.model(...).pricing()` first, then a provider-reported cost (the Claude CLI's `total_cost_usd`), then the driver or preset default.

Drivers throw `RateLimitedError(accountId, message, quota: QuotaPatch)` for a rate limit. The skill runner applies the patch (§4.1) and sets the cooldown to the reported time when it is in the future, else to `now + quotaPolicy.defaultCooldownMs`, so a `Retry-After: 0` cannot spin the retry loop.

### §2.4 Drivers and accounts

```typescript
export interface DriverInvokeRequest {
  readonly accountId: string;
  readonly modelId: string;
  readonly modelOptions: Record<string, unknown>;
  readonly pricing?: PricingAdapter;          // H.model(...).pricing(adapter)
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly outputJsonSchema: Record<string, unknown>;
  readonly workDir: string;
  readonly allowedTools?: readonly string[];
  readonly customTools?: ReadonlyMap<string, Executable<any, any>>;
  readonly maxContextTokens?: number;
  readonly handoffBufferTokens?: number;      // agent.handoffBuffer(tokens), default 30_000
  readonly hookServerUrl?: string;            // the hook receiver's URL, set only when the driver has a hookProtocol
  readonly invocationId?: string;             // carried in the hook URL
  readonly hookSubscriptions?: HookSubscriptions;
  readonly runId: string;
  readonly stepName: string;
  readonly sessionId?: string;
  readonly resumeSession?: boolean;
  readonly inactivityTimeoutMs: number;
  readonly signal: AbortSignal;
}

export interface DriverInvokeResult {
  readonly structuredOutput: unknown;
  readonly rawText: string;
  readonly sessionId: string;
  readonly usage: TokenUsage;
  readonly handoffRequested?: { readonly summary: string; readonly remainingWork: readonly string[] };
  readonly quotaHint?: QuotaPatch;
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
  submit(
    items: readonly BatchItemRequest[],
    modelId: string,
    opts: Record<string, unknown>,
    pricing?: PricingAdapter,                 // the model's pricing override
  ): Promise<{ batchId: string }>;
  poll(batchId: string): Promise<{ status: 'running' | 'completed' | 'failed'; results?: readonly BatchItemResult[] }>;
  cancel?(batchId: string): Promise<void>;
}

export interface Driver {
  readonly kind: string;
  invoke(req: DriverInvokeRequest): Promise<DriverInvokeResult>;
  probeQuota?(accountId: string): Promise<QuotaPatch>;
  readonly quotaPolicy?: Partial<QuotaPolicy>;
  readonly hookProtocol?: HookProtocol;       // how this driver's agents report tool events
  readonly batch?: BatchAdapter;
}

export interface ResolvedAccount {
  readonly accountId: string;
  readonly driver: Driver;
  readonly maxQuotaShare: number;
  readonly quotaPolicy: QuotaPolicy;
}

export interface AccountProvider {
  readonly id: string;
  readonly maxQuotaShareValue: number;
  maxQuotaShare(ratio: number): this;
  acquireAccount(store: HarnessStore): Promise<ResolvedAccount>;
}
```

### §2.5 Hooks and plugins

```typescript
export type ToolEventPhase = 'pre-tool' | 'post-tool' | 'stop';
export type ToolIntent = 'file-write';

export interface ToolEvent {
  readonly phase: ToolEventPhase;
  readonly intent: ToolIntent | null;      // null: a tool the protocol does not classify
  readonly toolName?: string;
  readonly filePaths: readonly string[];
  readonly sessionId?: string;
  readonly transcriptPath?: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface HookDecision {
  readonly allow: boolean;
  readonly reason?: string;
  readonly additionalContext?: string;
}

export interface HookSubscriptions {
  readonly preToolIntents: readonly ToolIntent[];
  readonly stop: boolean;
}

export interface HookProtocol {
  readonly name: string;
  buildSettings(endpoint: string, subscriptions: HookSubscriptions): Record<string, unknown>;
  parse(payload: Record<string, unknown>): ToolEvent | null;
  formatDecision(event: ToolEvent, decision: HookDecision): Record<string, unknown>;
  readContextTokens(transcriptPath: string): number;
}

export interface HookRegistration {
  readonly runId: string;
  readonly workDir: string;
  readonly protocol: HookProtocol;
  readonly plugins: readonly AgentPlugin[];
  readonly customTools: ReadonlyMap<string, Executable<any, any>>;
}

export interface HookReceiver {
  readonly url: string;
  register(invocationId: string, registration: HookRegistration): void;
  unregister(invocationId: string): void;
}

export interface AgentPlugin {
  readonly name: string;
  readonly preTool?: PluginHandler & { readonly intents: readonly ToolIntent[] };
  readonly stop?: PluginHandler;
}
```

The driver that spawns an agent owns its `HookProtocol`. Before each invocation, the skill runner registers `{ runId, workDir, protocol, plugins, customTools }` with the run's `HookReceiver` under the invocation id, and unregisters it when the invocation ends, so batch items and parallel agents each get their own plugins. An agent with plugins throws when its account's driver has no `hookProtocol`, or when the run has no hook receiver, instead of running unguarded. The MCP server receives agent callbacks on `/internal/hook?invocation=<id>`, parses them with the registered protocol, runs the plugins whose subscription matches the event, and answers with `protocol.formatDecision(...)`. A callback without an invocation is the Head's and uses `H.head().headProtocol(p)` (default `claude-code`). A callback for an unknown or finished invocation answers `{}`.

## §3. SQLite Schema (`src/schema.ts`)

State is persisted in `<projectDir>/.harness/runtime.db` using `better-sqlite3` in `WAL` mode (`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;`) and `drizzle-orm/better-sqlite3`. The schema version is kept in `PRAGMA user_version` (`SCHEMA_VERSION = 1`). A 0.2.0 database is renamed to `runtime.db.v<old>.bak` (with a timestamp suffix if that name is taken) and a fresh one is created.

```typescript
import { integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
  cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  actualCostUsd: real('actual_cost_usd'),          // null: unpriced
  equivalentCostUsd: real('equivalent_cost_usd'),  // null: unpriced
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
```

## §4. Account Pool & Reactive Quota Engine (`src/quota.ts`)

### §4.1 Quota Eligibility Check

When `pool.acquireAccount(store)` is called, each member account is evaluated against its effective `QuotaPolicy` (§2.2):

1. **Refresh Expired Windows:** Every window with `now >= resetsAtMs` is reset to `utilization = 0, resetsAtMs = null`. If it is the policy's `shareResetWindowId`, `projectShareUsed` and `windowTokensUsed` reset to `0`. A window without a reset time stops blocking once it is older than `probeStalenessMs` (by `updated_at_ms`). If `now >= cooldownUntilMs`, the cooldown is cleared.
2. **Optional Probe:** If the driver has `probeQuota` and `now - probedAtMs > policy.probeStalenessMs` (or it was never probed), call it and apply the result. Acquiring an account updates `acquiredAtMs`, never `probedAtMs`, so a busy account is still re-probed.

Every quota patch (a run's `quotaHint`, a `RateLimitedError`, a probe) goes through `applyQuotaPatch`: if it reports the share window with a lower utilization or a later reset time than stored (an early or bonus reset, or a run that spanned the reset), `projectShareUsed` and `windowTokensUsed` reset to `0`.
3. **Effective Cap Calculation:**
   `effectiveShareCap = Math.min(account share override ?? account.maxQuotaShareValue, pool.maxQuotaShareValue)`
4. **Filter Eligible Accounts:** An account is eligible if and only if:
   - `cooldownUntilMs === null || cooldownUntilMs <= now`
   - `projectShareUsed < effectiveShareCap`
   - every window has `utilization < (policy.thresholds[window.id] ?? policy.defaultThreshold)`
5. **Apply Reserve Rule:** If `pool.reserve` specifies `{ minFreeAccounts, maxBurstUtilization }`, the `minFreeAccounts` eligible accounts with the lowest peak utilization below `maxBurstUtilization` are reserved. The pool picks from the other eligible accounts first, then the fallback, and uses a reserved account only when neither is available.
6. **Sort by Strategy:**
   - `'drain-soonest-expiring'`: Sort ascending by the reset time of the share window (`Infinity` when unknown), breaking ties by peak window utilization ascending.
   - `'least-used'`: Sort ascending by `Math.max(peak window utilization, projectShareUsed)`.
   - `'priority'`: Keep declaration order.
   - `'round-robin'`: Sort ascending by `acquiredAtMs`.
7. **Exhaustion:** With no account left, throw `QuotaExhaustedError(nextAvailableAtMs)`. An account's `nextAvailableAtMs` is the latest end among the conditions blocking it (cooldown end, blocking windows' resets or staleness, the share window's reset when over the share cap), or `null` when one has no known end; the pool reports the soonest across its accounts.

The skill runner and the batch path charge each finished invocation's tokens to `windowTokensUsed` and, when the resolved account's policy has a `tokenBudget`, add `tokens / tokenBudget` to `projectShareUsed` (capped at `1`).

### §4.2 Reactive Rate-Limit Discovery

- **HTTP drivers:** The AI SDK driver passes the response (status, headers and, on a `429`, the parsed error body) to its `RateLimitAdapter` on every success and every `429`. First-party adapters: `anthropicRateLimits` (`anthropic-ratelimit-unified-{5h,7d}-*` → `anthropic:5h`/`anthropic:7d`, `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-*` → `anthropic:<kind>`), `openaiRateLimits` (`x-ratelimit-{limit,remaining,reset}-{requests,tokens}` with `6m0s`/`500ms` durations → `openai:<kind>`, `retry-after-ms`), and `ietfRateLimits` (`RateLimit-Limit/Remaining/Reset` → `http:ratelimit`, `Retry-After` as seconds or HTTP-date). `googleRateLimits` adds `google.rpc.RetryInfo.retryDelay` from the Gemini error body to the IETF headers. `composeRateLimits(...)` merges adapters, keeping the last adapter's window per id and the latest cooldown. `generateText` retries a `429` itself and then throws `RetryError`; the driver reads the status and headers from its `lastError`.
- **Claude CLI driver:** Reads the stream-json `rate_limit_event` (`rate_limit_info.unifiedWindows.{five_hour,seven_day}.{utilization,resetsAt}` → `anthropic:5h`/`anthropic:7d`) on every run and returns it as the `quotaHint`. A turn counts as rate limited only when an error event or error result says so (`api_error_status: 429`, or the words "rate limit(ed)", "usage limit" or `429` in the error), or when a run that produced no output exits non-zero with that text on stderr. The cooldown is the rejected window's `resetsAt`, else a reset time parsed from the error text, else the policy default.

## §5. Driver Implementations (`src/drivers/`)

### §5.1 Claude CLI Driver (`src/drivers/claude-cli.ts`)

Spawns the `claude` CLI in non-interactive streaming mode.

1. **Ephemeral Hook Settings Generation:**
   Writes `<tmpdir>/harness-cli-settings/settings-<runId>-<stepName>-<uuid>.json` from `claudeCodeHookProtocol.buildSettings(endpoint, req.hookSubscriptions)`, where `endpoint` is `hookEndpointUrl(hookServerUrl, invocationId)`:
   ```json
   {
     "hooks": {
       "PreToolUse": [{
         "matcher": "Edit|Write|MultiEdit",
         "hooks": [{ "type": "command", "command": "curl -sS -X POST \"http://127.0.0.1:<port>/internal/hook?invocation=<invocationId>\" -H \"content-type: application/json\" --data-binary @-" }]
       }],
       "Stop": [{
         "hooks": [{ "type": "command", "command": "<same curl command>" }]
       }]
     }
   }
   ```
   `PreToolUse` is written when a plugin subscribes to the `file-write` intent, `Stop` when a plugin has a stop handler.
2. **CLI Arguments:**
   ```bash
   claude -p \
     --model <modelId> \
     --session-id <sessionId> \
     --output-format stream-json \
     --verbose \
     --json-schema '<JSON.stringify(req.outputJsonSchema)>' \
     --settings <settings file> \
     --append-system-prompt "<req.systemPrompt + filteredLessons>" \
     --allowedTools "<req.allowedTools.join(',')>" \
     --strict-mcp-config \
     "<req.userPrompt>"
   ```
   Environment includes `{ ...process.env, CLAUDE_CONFIG_DIR: configDir }`.
3. **Real-Time Stream Monitoring (`stdout` line-by-line JSONL):**
   - Resets the `inactivityTimeoutMs` watchdog timer on every JSONL line. If the timer fires, kills the process tree and throws `InactivityTimeoutError`.
   - Reads usage from every event for token totals (input includes cache reads and writes), and checks the context ceiling on assistant messages only:
     `totalContext = input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens`.
   - **Context Ceiling Guard:** If `req.maxContextTokens` is set and an assistant message's `totalContext >= req.maxContextTokens - req.handoffBufferTokens` (default 30_000), flags the run for handoff: once the current turn finishes, resumes it with a 1-turn handoff prompt, captures `{ summary, remainingWork }` and spawns a fresh session on the same `workDir` with the handoff summary.
   - Reads `rate_limit_event` lines (§4.2).
   - Extracts the final `result` event's `structured_output` (or parses the final assistant JSON block). The subscription-equivalent cost is `req.pricing.estimate(...)` when the model has a pricing override, else the result's `total_cost_usd`, else `anthropicPricing.estimate(...)`. The actual cost is `0`.

### §5.2 AI SDK & Cloud Batch Driver (`src/drivers/ai-sdk.ts`)

1. **Provider Presets:**
   `H.drivers.aiSdk({ provider })` takes `'anthropic' | 'openai' | 'google'` or a user `ProviderPreset`:
   ```typescript
   export interface ProviderPreset {
     readonly name: string;
     readonly apiKeyEnv?: string;
     createModel(modelId: string, connection: ProviderConnection): LanguageModel;
     mapModelOptions?(options: Record<string, unknown>): ProviderOptions | undefined;
     readonly rateLimits?: RateLimitAdapter;
     readonly pricing?: PricingAdapter;
     createBatch?(connection: { apiKey: () => string; baseURL?: string; fetch?: typeof fetch; pricing: PricingAdapter }): BatchAdapter;
   }
   ```
   `anthropicPreset`, `openaiPreset` and `googlePreset` carry the API key variable, the `@ai-sdk/*` factory, the model-option mapping (`effort`, `thinkingBudget`, `cachePrefix`), the rate-limit adapter and the price list. A user preset makes any AI SDK model work (Bedrock, Mistral, OpenRouter, Ollama); it gets no first-party pricing (cost `null`) and needs an API key only when it names one. The driver options `fetch`, `rateLimits`, `pricing` and `batch?: BatchAdapter | false` override the preset, and the driver's pricing is passed to `createBatch`.
2. **Real-Time Calls:**
   Uses `generateText` with `Output.object({ schema })` and the preset's provider options. Cost is `(req.pricing ?? driver pricing).estimate(...)`, and actual equals equivalent.
3. **Cloud Batch Adapter (`batch/anthropic.ts`):**
   - `anthropicBatchAdapter({ apiKey, pricing, baseURL?, fetch?, maxTokens = 16_000, apiVersion = '2023-06-01', discount = 0.5, structuredOutput = 'output-format' })` submits to `POST <baseURL>/messages/batches`, polls `GET /messages/batches/:id` and reads `results_url` JSONL on completion.
   - `structuredOutput: 'output-format'` sends `output_config.format = { type: 'json_schema', schema }` and parses the text block. `'forced-tool'` sends a single `structured_output` tool with forced `tool_choice` and parses the `tool_use` input, for models without structured outputs. Current models (Opus 5.5, Sonnet 5.5, Fable 5.1) reject forced `tool_choice`.
   - The model's `effort` goes to `output_config.effort`. The shared system prompt carries an ephemeral cache marker.
   - Item usage counts input as `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`, with cache reads and writes reported separately. Item cost is priced by the result's `model` with the pricing passed at submit (the model's override) or the adapter's own; the actual cost is `equivalent * discount`.
   - OpenAI and Google batch adapters are not implemented (planned for 0.4.0). Those drivers run batch steps through the bounded local queue (`p-queue`).

### §5.3 Schema Validation & Self-Correction Loop

In `BoundAgentSkill.execute(input, ctx)`:
1. Validate `input` with `skill.inputSchema.parse(input)`.
2. Convert `skill.outputSchema` to JSON Schema using Zod v4's `z.toJSONSchema(skill.outputSchema)`.
3. Invoke the model driver.
4. Parse `result.structuredOutput` with `skill.outputSchema.safeParse(...)` and run `skill.assertFn?.(parsed.data, input)`.
5. If validation or `.assert()` fails and `attempt <= skill.maxRetriesCount`:
   Re-invoke with the validation error message appended so the model repairs its output.
6. A handoff starts a fresh session with the summary; more than `agent.maxHandoffs(n)` (default 3) consecutive handoffs fail the step with `HandoffLimitError`.
7. A `RateLimitedError` cools the account down (§2.3) and retries on the next eligible account until the pool is exhausted.

---

## §6. Local & Agentless SSH Runner Engine (`src/runner.ts`)

### §6.1 Concurrency Slots & Port Ranges

Each `Runner` instance holds a `PQueue({ concurrency: maxConcurrentSlots })` and a free-slot bitmask `[0 .. maxConcurrentSlots - 1]`.
When a job acquires slot `k`:
- `slotPorts` are `[slotPortBase + k * portsPerSlot, ..., slotPortBase + (k + 1) * portsPerSlot - 1]` (`portsPerSlot` defaults to `10`).
- Injected into the command environment as `HARNESS_SLOT=k` and `PORT=${slotPorts[0]}`, plus whatever `slotEnv(k, slotPorts)` returns (for example a project's `PORT_API` / `PORT_WEB` names), plus the command's own env.

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
     trap \"kill -TERM -\$\$ 2>/dev/null; sleep 0.2; kill -KILL -\$\$ 2>/dev/null\" EXIT INT TERM HUP;
     cd '<remoteWorkDir>' && export NAME='<value>'; ... <command>
   '"
   ```
   Every env value and the work dir are single-quoted for the inner shell and the script is quoted once for the outer one, so values with spaces or shell metacharacters arrive intact. Env names must match `[A-Za-z_][A-Za-z0-9_]*`.
   If the local orchestrator aborts the `execa` call, times out, or loses the SSH connection, `sshd` closes the pipe, triggering `HUP`/`EXIT` inside the `setsid` leader, which immediately kills `-$$` (every child process spawned by the job on `wb`/`wb2`).

---

## §7. Flow Execution Engine (`src/engine.ts`)

`FlowEngine.run(flowDef, rawInput, opts)` executes the declarative AST of `FlowStepNode`s:

1. **Initialization:**
   - Validates `rawInput` against `flowDef.inputSchema`.
   - Takes the run's ticket id and touched paths from `FlowRunOptions.ticketId / touchedPaths`, else from `H.flow(...).identify({ ticketId, touchedPaths })`, else none. The engine reads no input field by name.
   - Inserts a `workflow_runs` row with status `'running'` and triggers `store.projectBoard()`.
   - Runs any attached flow middlewares (`flowDef.middlewares`, such as `gitWorktreeIsolation`), which wrap the execution in a `try / finally` block.
2. **Node Execution:**
   - `step`: Maps `ctx` through `inputMapper`, calls `executable.execute(mappedInput, execCtx)`, stores result at `ctx.steps[step.name]`, persists `stateJson` in `workflow_runs`, and updates `BOARD.md`.
   - `when`: Evaluates `predicate(ctx)`. If true, executes the inner node/subflow.
   - `branch`: Evaluates `selector(ctx)` and executes the matching branch node.
   - `parallel`: Executes all branches via `Promise.all()`, assigning each output to `ctx.steps[key]`.
   - `loop`: Loops `iteration = 0 .. maxIterations - 1`. At the end of each iteration, evaluates `until(ctx)`. If true, breaks out of the loop. Otherwise copies `ctx.steps` to `ctx.prev` and starts the next iteration. If `maxIterations` is exhausted without `until(ctx)` returning true, halts as `'blocked'` (or throws `MaxIterationsReachedError` if configured).
   - `batch`: Resolves `items(ctx)`. If the target `Executable` uses a `Driver` with a `batch` adapter and `items.length > 1`, submits via `driver.batch.submit()` and polls to completion; otherwise maps items through `PQueue({ concurrency })`. A failed or invalid cloud item finishes the batch invocation as `fail` with the tokens and costs of all returned items before the step throws.
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

The MCP server is the run's `HookReceiver` (§2.5). Agent callbacks carry `?invocation=<id>`; the registered protocol parses the body into a `ToolEvent`:
1. **Context Tracking:** For an agent invocation, `protocol.readContextTokens(event.transcriptPath)` updates that run's context usage on the board. A callback without an invocation is the Head's: the Head protocol measures its transcript and updates `head_sessions`, and if `contextTokens >= headDef.contextNoticeThreshold`, the answer carries `additionalContext` instructing `Head` to call `harness_handoff`. `harness_ground` and MCP results measure the Head's transcript with the same Head protocol. The Head's own `PostToolUse` hook on `mcp__harness__*` is configured in the Head's Claude Code settings, not generated (planned for the 0.4.0 Head-client adapter).
2. **`pre-tool` (`fileLeaseGuard` plugin):** For plugins subscribed to the event's intent, checks each of `event.filePaths` against `file_leases` using `picomatch`. If no other run holds a lease on the file, acquires it for the run and allows; if another run holds it, the answer denies with a reason.
3. **`stop` (`stopCommandHook` plugin):** Runs the configured `H.command` with `{ workDir }`, or with `mapInput(...)` when the command needs another input (required by its type then). By default the output must be `{ passed: boolean, summary?: string }`; any other output needs a `verdict(output) => { allow, reason }` option. On a failed check, the answer blocks with the summary so the agent fixes the issue inside the same turn.
4. **Errors:** A plugin handler that throws blocks with the error as the reason; the HTTP handler always answers.
5. **Answers:** `protocol.formatDecision(event, decision)`. For Claude Code: a denied `PreToolUse` answers `hookSpecificOutput.permissionDecision: 'deny'`, a blocked `Stop` answers `{ decision: 'block', reason }`, and an allow answers `{}` so Claude Code's own permission checks still apply.

## §9. Verification & End-to-End Test Plan

### §9.1 Unit & Failure-Injection Suite (`test/unit/`)
Run via `pnpm test`:
1. **`dsl-types.test.ts`:** Verifies compile-time and runtime type propagation across `.step()`, `.when()`, `.branch()`, `.parallel()`, `.loop()`, and `.batch()`.
2. **`quota-pool.test.ts`:** Verifies per-account `.maxQuotaShare()`, per-pool `.maxQuotaShare()`, `'drain-soonest-expiring'` ordering, reactive `429` cooldown failover, and early-reset recovery. Includes a break-once check proving an account over its share cap is never selected.
3. **`engine-combinators.test.ts`:** Tests `.loop()` convergence, dispute arbitration branching, `.haltIf()` pause and `resolveBlocker()` resume, and Zod output validation auto-retry on malformed LLM output using `H.drivers.mock()`.
4. **`plugins-and-mcp.test.ts`:** Tests `fileLeaseGuard()` dynamic lease acquisition and cross-run conflict denial, `gitWorktreeIsolation()` branch creation and cleanup, and `stopCommandHook()` blocking behavior.
5. **`runner-process-cleanup.test.ts`:** Spawns a command that forks a background child process, triggers an inactivity timeout, and asserts the child PID is terminated.
6. **`store-and-projections.test.ts`:** Verifies SQLite persistence, schema-version backup, `.harness/lessons.jsonl` role+glob filtering, and `.harness/BOARD.md` (one column per quota window) / `.harness/TELEMETRY.md` generation.
7. **`rate-limits.test.ts`:** Header fixtures per rate-limit adapter, the Claude CLI `rate_limit_event` (fixture captured from Claude Code 2.1.309), rate-limit detection on failed turns only, `RetryError` unwrapping, and the policy default cooldown.
8. **`pricing.test.ts`:** Price-list matching (platform prefixes, dated snapshots, longest id, version boundaries), long-context tiers, scheduled price changes, the CLI-reported cost, the per-model override, and unpriced telemetry.
9. **`presets-and-batch.test.ts`:** A user preset end to end, first-party model-option mapping, and the Anthropic batch adapter in both structured-output modes.
10. **`hook-protocol.test.ts`:** The Claude Code protocol round trip, `fileLeaseGuard` through a non-Claude protocol, the Head transcript reader, and the handoff buffer.
11. **`core-boundary.test.ts`:** Fails when a core file reaches an adapter directory through its imports, or a core or plugin file names a provider, CLI or project.
12. **`hook-safety.test.ts`:** Per-invocation hook registration (single, batch and parallel agents), throwing handlers, missing hook protocols or receivers, the Head protocol, the transcript tail, handoff limits and the rate-limit cooldown clamp.
13. **`drivers-and-skills.test.ts`:** The Claude CLI driver's stream parsing, handoff and resume, skill self-correction, and commands with `.envFrom()`.

### §9.2 Live End-to-End Suite (`test/e2e/`)
Run via `node --env-file=.env pnpm test:e2e` (secrets are loaded by Node into `process.env` and never read or printed by any agent):
1. **`claude-cli-pool.e2e.test.ts`:** Executes a real `H.agent` + `H.skill` over `H.drivers.claudeCli()` using your subscription credentials, verifies strict Zod `--json-schema` compliance, verifies live token/cost telemetry in SQLite, and forces a live failover from Account 1 to Account 2 via `.maxQuotaShare()`.
2. **`ai-sdk-and-batch.e2e.test.ts`:** Executes a real `H.skill` and a 2-item `H.batch` against the SDK provider using the API key in `.env`, verifying schema validation and `actualCostUsd` accounting.
3. **`full-coding-loop.e2e.test.ts`:** Creates a temporary git repository in `/tmp`, runs a complete `Builder → Stop Hook (vitest) → Dispute Arbiter → Auditor → Merge` flow on a real broken TypeScript module, and asserts the resulting `main` branch passes tests cleanly.
4. **`mcp-head.e2e.test.ts`:** Starts the HTTP/MCP server, connects a real `@modelcontextprotocol/sdk` client, executes `harness_ground()`, invokes a custom `.tool()` (`RepoExplorer`), resolves a live `.haltIf()` blocker via `blocker_resolve`, and verifies the workflow completes.
