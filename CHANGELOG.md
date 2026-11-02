# Changelog

## 0.4.0

A new kernel. A flow is a declared tree of named steps, never an async function; every effect has an address on a ledger and the engine replays from it. Work is units of a kind with declared states and positions, queued through lanes with a scheduler; seats sit on model pools whose accounts draw on shared quota partitions; halts are typed questions resolved by clients, policies or clocks; triggers and metrics read the event stream; clients get typed grants; observers subscribe. The core names no provider; every provider, CLI, store and transport is an adapter on a kernel contract, exported as a subpath.

### Added

- **Kernel contracts** (`harness-dsl/kernel`): `Ledger`, `QuotaPartition`, `Store`, `MemoryStore`, `Supplier`, `ModelDriver` (`invoke`, `session`, `submitBatch`, `collectBatch`, `hooks`, `guardProtocol`), `RunnerBackend`, `WorkspaceBackend`, `Client`, `ControlApi`, `Observer`, `Resolver`, and the ledger event union.
- **The DSL** (`H.*`): kinds and states, signals and halts, resources and facets, roles, memory and journals, pools, seats, commands, jobs and batches, flows (`step`, `halt`, `read`, `spawn`, `wait`, `when`, `parallel`, `loop` with carry and span, `exit`), lanes (supply, handler with an exit map, store, typed retry end states, leases, order, reactions, ceilings), triggers and sources, metrics, policies, the scheduler, grants and operations, the harness. `validate(harness)` with 22 startup rules.
- **The engine**: addresses and a flow version; replay over the ledger; `effect` handling for commands; seat recovery through the driver's session; jobs collected, never resubmitted; loops with carry and span; halts with facets, skip policies, timeouts and escalations; reactions with deferred patches and rewinds; retry and exhaustion; demand per tick (WIP, pause, expedite holds, fixed dates, aging, admission); triggers with crossings per facet and hysteresis; metrics folded with sample counts; account rotation on refusal and a `budget` block; `distinct` model policies by registration precedence; recall by journal policy with track records; guards (area leases on write, `beforeStop` checks) through the hook protocol; the control API; observers and subscribers on every append; `Runtime.run()`.
- **Adapters**: `sqlite` (ledger, quota partition), `claude-code` (driver, supervisor over MCP, session config), `anthropic`, `google`, `openrouter` (AI SDK drivers with batch), `gemini-cli` (driver with hooks), `http` (control API with a bearer token and server-sent events), `markdown` (board, telemetry), `slack`, `local`, `ssh`, `git` (worktree workspaces), `jsonl` (memory store).
- **Batch adapters** for OpenRouter (inline requests, JSON schema response format) and Gemini batch mode (inline requests, operation polling), beside the Anthropic one.
- **One agent-CLI driver** under the Claude CLI and the Gemini CLI: a spawn in its own process group, a watchdog on silence, stream parsing per CLI, hook settings placed per run, the agent's pid kept while it runs, and refusals mapped to account cooldowns.
- **`harness` CLI**: `start`, `status`, `install --launchd | --systemd`.
- `start(harness, options)` and `processResolver()` at the package root.

### Changed

- The provider SDKs (`@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai`) are optional peer dependencies loaded on first use.
- Observed quota windows carry a kind: allowance windows feed utilization and the share; a saturated throttle window is a cooldown until its reset. A harness's share of an account is the utilization rise observed across its own calls, not a token budget.
- The claude CLI driver's `runId` is only a file-name component; the handoff loop and the `maxContextTokens`, `handoffBufferTokens`, `isIncomplete` and `customTools` request fields are gone.

### Removed

- The 0.3.0 kernel: `H.account`, `H.model`, `H.agent`, `H.skill`, `H.head`, `startOrchestrator`, `HarnessStore`, `FlowEngine`, the `.harness/` store, `BOARD.md` and `TELEMETRY.md` as store writes, tickets and lessons files, `harness-dsl/plugins` (`gitWorktreeIsolation`, `fileLeaseGuard`, `stopCommandHook`), the mock and custom drivers, the `drizzle/` migrations.

### Not verified live

- The OpenRouter and Gemini batch adapters are verified against the providers' documented shapes, not against a live batch.
- The Gemini CLI's hook enabling keys (`tools.enableHooks`, `hooks.enabled`) follow the documentation of an experimental feature; a guarded Gemini step has not run live.

## 0.3.0

The core no longer names a provider, CLI, model, header, price, hook format, transcript format, port name or input field. Each lives behind an adapter with a first-party default. `test/unit/core-boundary.test.ts` enforces the boundary over the transitive imports of every core file. One known exception remains until 0.4.0: the Head's `.mcp.json` is Claude Code's format.

### Added

- **Quota model:** quota windows (`QuotaWindow { id, utilization, resetsAtMs }`) per account. A `QuotaPolicy` sets per-window thresholds, probe staleness, token budget, share-reset window and default cooldown. `H.account(...).quotaPolicy({...})` and `Driver.quotaPolicy` set it, and `CLAUDE_SUBSCRIPTION_QUOTA_POLICY` is the Claude CLI default. `ANTHROPIC_5H_WINDOW` / `ANTHROPIC_7D_WINDOW` name the subscription windows.
- **Rate limits:** `RateLimitAdapter.fromResponse({ status, headers, body })`, with `anthropicRateLimits`, `openaiRateLimits`, `googleRateLimits` (Gemini `RetryInfo` in the 429 body), `ietfRateLimits` and `composeRateLimits`. Header helpers are exported for custom adapters. The Claude CLI driver reports live `anthropic:5h` / `anthropic:7d` windows from its stream-json `rate_limit_event`.
- **Pricing:** `PricingAdapter`, with dated price lists for Anthropic, OpenAI and Google (`anthropicPricing`, `openaiPricing`, `googlePricing`, `priceListPricing`). Lists support cache-read and cache-write rates, long-context tiers and scheduled price changes. `H.model(...).pricing(adapter)` overrides pricing on every path. `TokenCounts.cacheWriteTokens` is new, and `inputTokens` is defined to include cache reads and writes.
- **Provider presets:** `ProviderPreset` (`anthropicPreset`, `openaiPreset`, `googlePreset`). `H.drivers.aiSdk({ provider })` accepts a user preset for any AI SDK model.
- **Batch:** `anthropicBatchAdapter({ apiKey, pricing, baseURL?, fetch?, maxTokens?, apiVersion?, discount?, structuredOutput? })`. `apiKey` (a function) and `pricing` are required when you build one yourself; the Anthropic preset supplies both.
- **Hooks:**
  - `HookProtocol` (`claudeCodeHookProtocol`) parses tool events, formats decisions and measures transcripts.
  - `ToolEvent` carries the tool name and raw payload.
  - Each invocation registers its plugins with the run's `HookReceiver`, which is the orchestrator's MCP server.
  - `Driver.hookProtocol` and `H.head().headProtocol(p)` are new.
- **Agents and flows:** `agent.handoffBuffer(tokens)`, `agent.maxHandoffs(n)` with `HandoffLimitError`, and `H.flow(...).identify({ ticketId, touchedPaths })`.
- **Runner:** `LocalRunnerOptions.portsPerSlot` / `slotEnv`.
- **Stop hook:** `stopCommandHook(command, { mapInput, verdict })`, with options typed from the command.
- **Schema migrations:** drizzle-kit migrations in `drizzle/` (baseline `0000_baseline`), applied when the store opens; `pnpm db:generate` creates the next one from `src/schema.ts`.
- **Custom drivers:** they take `quotaPolicy` and `hookProtocol`, and should honour `DriverInvokeRequest.pricing`, `handoffBufferTokens` and `invocationId`.

### Fixed

**Rate limits**
- A successful Claude CLI run whose output mentioned "rate limit" was treated as rate limited. Errors naming `rate_limiter` / `ratelimit.ts` were too.
- "Not logged in" was treated as a rate limit, which hid logged-out pool accounts behind the paid fallback. An authentication failure (logged out, expired OAuth token, invalid key, HTTP 401/403) now throws `AccountUnavailableError`. It takes the account out of rotation for `QuotaPolicy.unavailableCooldownMs` (default 15 minutes), shows it as `UNAVAILABLE: <reason>` on BOARD.md, and fails over to the next account.
- AI SDK 429s arrive wrapped in `RetryError`, and their rate-limit headers were never read.
- A rate limit whose cooldown was already over (`Retry-After: 0`, a past reset) made the skill loop retry forever.

**Quota**
- A busy account was never re-probed, because every acquire reset the probe staleness clock.
- A run's report of a share-window reset (lower utilization, or a later reset time) never freed the project share; only a probe could, and the Claude CLI has none.
- A window recorded with high utilization and no reset time blocked its account forever.
- The same account under two policies was charged against the wrong token budget.
- `nextAvailableAtMs` could be earlier than the active cooldown.
- The reserve rule sent work to the paid fallback while non-reserved accounts were eligible.
- A share-window reset left `windowTokensUsed` in place.

**Hooks and plugins**
- When no plugin objected, the hook answered `{ decision: 'approve' }`, which Claude Code reads on `PreToolUse` as an allow that skips its permission check. It now answers `{}`.
- A throwing plugin handler left the hook call without an answer, so the guard failed open. The error now blocks.
- Agents inside `.batch()` never got their hook plugins, and parallel agents answered each other's hooks.
- An agent with plugins on a driver without hook support, or outside an orchestrator, ran unguarded. It now throws.
- The Head's context notice and `harness_ground` measured the transcript differently. The transcript reader also returned 0 when the last line was over 64 KiB.
- `stopCommandHook` allowed a stop when the output had neither `passed` nor `exitCode`, and guessed `worktreePath` as the command input.

**Handoffs**
- The Claude CLI driver checked the context ceiling against the result event's cumulative usage, which started spurious handoffs.
- A task that hit the context ceiling every session handed off forever.
- The driver's handoff buffer defaulted to 0 while the DSL's defaulted to 30_000.

**Costs and batch**
- Costs were estimated from `opus` / `haiku` substrings at retired prices, and every other model was billed at Sonnet rates. Unknown models are now recorded as unpriced.
- Batch costs under-reported by up to 11× (exclusive input tokens, dropped cache writes) and ignored pricing overrides. The CLI-reported cost also beat an explicit model override.
- Anthropic batch requests forced `tool_choice`, which Opus 5.5, Sonnet 5.5 and Fable 5.1 reject. They now use `output_config.format`, carry the model's `effort`, and default to 16000 max tokens.
- A cloud batch with one failed item left its invocation `running` and never recorded the paid tokens.

**Other**
- SSH runner env values with spaces or shell metacharacters broke the remote command.
- An existing `runtime.db` from another schema version kept its old columns.
- `.input()` after `.identify()` kept callbacks typed on the old input.
- User price-list entries with capitals never matched.

### Breaking

**Quota and store**
- `QuotaSnapshot` is replaced by `QuotaPatch` / `QuotaWindow` / `QuotaPolicy`.
- `Driver.probeQuota` and `DriverInvokeResult.quotaHint` return `QuotaPatch`, and `ResolvedAccount` carries `quotaPolicy`.
- `HarnessStore.getAccountQuota` / `listAccountQuotas` return `AccountQuotaState`: `windows` replaces the 5h/7d fields and `updatedAtMs`.
- `upsertAccountQuota` takes `AccountQuotaPatch`.
- `recordAccountTokenUsage(accountId, tokens, tokenBudget)` takes the budget, `registerQuotaPolicy` is removed, and `finishInvocation` no longer charges quota.
- The `account_status` and `harness_ground` MCP payloads change shape accordingly.
- An account without a `tokenBudget` no longer derives project share from tokens. The Claude CLI driver keeps 5,000,000.
- `.quotaPolicy()` replaces an earlier override instead of merging.

**Rate limits and pricing**
- `parseRateLimitHeaders` is removed. `RateLimitAdapter.fromHeaders` is now `fromResponse`.
- Drivers throw `RateLimitedError` instead of errors carrying `cooldownUntilMs`.
- `TokenUsage.actualCostUsd` / `equivalentCostUsd` and the invocation cost columns are `number | null`.
- `BatchAdapter.submit` takes an optional pricing argument, and `ProviderPreset.createBatch` receives pricing.

**AI SDK driver**
- `AiSdkDriverOptions.useCloudBatch` is replaced by `batch?: BatchAdapter | false`, and `customFetch` by `fetch`.
- `AiSdkDriver.provider` is replaced by `preset`.
- `Driver.kind` is an open string.

**Hooks and plugins**
- `AgentPlugin` `hookTypes` / `onPreToolUse` / `onStop` are replaced by `preTool` / `stop` handlers taking a `ToolEvent`.
- Agents can no longer subscribe to `PostToolUse`; it had no handler in 0.2.0.
- `DriverInvokeRequest.hookTypes` is replaced by `hookSubscriptions` plus `invocationId`.
- `ClaudeCliDriver.buildHookSettingsJson` is removed.
- `ExecutionContext.hookServerUrl` and `FlowRunOptions.hookServerUrl` / `onActivePluginsChange` are replaced by `hookReceiver`.
- `HarnessMcpServer.registerRunPlugins` / `unregisterRunPlugins` are replaced by `register` / `unregister(invocationId, registration)`, and `handleHookCallback` takes `(invocationId, payload)`.
- The hook URL carries `?invocation=` instead of `event=` / `runId=`, and the event comes from the payload.
- `readTranscriptContextTokens` is now `readClaudeCodeTranscriptTokens`, and `HookProtocol.readContextTokens` is required.
- `H.head().transcriptReader()` is replaced by `.headProtocol()`.
- Agents with plugins now throw on a driver without `hookProtocol` or in a run without a hook receiver.

**Stop hook**
- `stopCommandHook`'s second argument is an options object typed from the command.
- Its default input is `{ workDir }`.
- An output with `exitCode` but no `passed` needs a `verdict`, and the block reason no longer falls back to `stderr` or the output's JSON.

**Engine and runner**
- `ExecutionContext.slotIndex` / `slotPorts` are removed; commands read them from `exec()`.
- The default slot env no longer sets `PORT_API` / `PORT_WEB` / `PORT_ADMIN`.
- The flow engine no longer reads `input.id` / `input.touches`; use `.identify()`.
- `ticket_write` has no `touches` argument.

**Files**
- The `BOARD.md` account table has one column per quota window. `TELEMETRY.md` cost cells show `—` or `+ unpriced` for unpriced models.
- `runtime.db`: databases from 0.2.0 are backed up to `runtime.db.v0.bak` and recreated, not migrated. From 0.3.0 on, the schema changes through drizzle-kit migrations shipped in `drizzle/` and applied on open, and a database written by a newer harness-dsl is refused.

OpenAI and Google batch adapters are not included; they are planned for 0.4.0.
