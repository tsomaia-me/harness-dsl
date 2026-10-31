# Changelog

## 0.3.0

The core no longer names a provider, CLI, model, header, price, hook format, transcript format, port name or input field. Each lives behind an adapter with a first-party default, and `test/unit/core-boundary.test.ts` enforces the boundary.

### Added

- Quota windows: `QuotaWindow { id, utilization, resetsAtMs }` per account, `QuotaPolicy` with per-window thresholds, and `H.account(...).quotaPolicy({...})`.
- `RateLimitAdapter` with `anthropicRateLimits`, `openaiRateLimits`, `ietfRateLimits` and `composeRateLimits`. `AiSdkDriverOptions.rateLimits` overrides the preset's adapter.
- The Claude CLI driver reports live `anthropic:5h` / `anthropic:7d` windows from the stream-json `rate_limit_event`.
- `PricingAdapter` with dated price lists for Anthropic, OpenAI and Google (`anthropicPricing`, `openaiPricing`, `googlePricing`, `priceListPricing`), long-context tiers, scheduled price changes, and `H.model(...).pricing(adapter)`. The Claude CLI driver records the CLI's own `total_cost_usd`.
- `ProviderPreset` (`anthropicPreset`, `openaiPreset`, `googlePreset`); `H.drivers.aiSdk({ provider })` accepts a user preset for any AI SDK model.
- `anthropicBatchAdapter({ maxTokens, apiVersion, baseURL, discount, structuredOutput })`.
- `HookProtocol` (`claudeCodeHookProtocol`), `ToolEvent`, `H.head().hookProtocol(p)` and `H.head().transcriptReader(fn)`.
- `agent.handoffBuffer(tokens)`, `H.flow(...).identify({ ticketId, touchedPaths })`, and `LocalRunnerOptions.portsPerSlot` / `slotEnv`.
- `stopCommandHook(command, { mapInput, verdict })`.

### Fixed

- A successful Claude CLI run whose output mentioned "rate limit" was treated as rate limited and cooled its account down. "Not logged in" is no longer treated as a rate limit.
- AI SDK 429s arrive wrapped in `RetryError`; their rate-limit headers were never read.
- A busy account was never re-probed, because every acquire reset the probe staleness clock.
- A share-window reset left `windowTokensUsed` in place.
- An existing `runtime.db` from another schema version kept its old columns. It is now backed up to `runtime.db.v<n>.bak` and recreated.
- Anthropic batch requests forced `tool_choice`, which Opus 5.5, Sonnet 5.5 and Fable 5.1 reject. They now use `output_config.format`, carry the model's `effort`, and default to 16000 max tokens instead of 4096.
- Costs were estimated from `opus` / `haiku` substrings at retired prices, and every other model, OpenAI and Gemini included, was billed at Sonnet rates. Unknown models are now recorded as unpriced.
- When no plugin objected, the hook answered `{ decision: 'approve' }`, which Claude Code reads on `PreToolUse` as an allow that skips its permission check. It now answers `{}`.
- `stopCommandHook` allowed a stop when the command's output had neither `passed` nor `exitCode`.

### Breaking

- `QuotaSnapshot` is replaced by `QuotaPatch` / `QuotaWindow` / `QuotaPolicy`. `Driver.probeQuota` and `DriverInvokeResult.quotaHint` return `QuotaPatch`. `ResolvedAccount` carries `quotaPolicy`. `recordAccountTokenUsage` takes no budget argument.
- An account without a `tokenBudget` no longer derives project share from tokens. The Claude CLI driver keeps 5,000,000.
- `parseRateLimitHeaders`, `parseRateLimitResetFromMessage` and `estimateEquivalentUsd` are removed. Drivers throw `RateLimitedError` instead of errors carrying `cooldownUntilMs`.
- `TokenUsage.actualCostUsd` / `equivalentCostUsd` and the invocation cost columns are `number | null`.
- `AiSdkDriverOptions.useCloudBatch` is replaced by `batch?: BatchAdapter | false`, and `AiSdkDriver.provider` by `preset`. `Driver.kind` is an open string.
- `AgentPlugin` `hookTypes` / `onPreToolUse` / `onStop` are replaced by `preTool` / `stop` handlers taking a `ToolEvent`. `DriverInvokeRequest.hookTypes` is replaced by `hookSubscriptions`. The hook URL carries `protocol=` instead of `event=`. `readTranscriptContextTokens` is now `readClaudeCodeTranscriptTokens`.
- `ExecutionContext.slotIndex` / `slotPorts` are removed; commands read them from `exec()`. The default slot env no longer sets `PORT_API` / `PORT_WEB` / `PORT_ADMIN`.
- The flow engine no longer reads `input.id` / `input.touches`; use `.identify()`.
- `stopCommandHook`'s second argument is an options object. `ticket_write` has no `touches` argument.
- `runtime.db` schema version 1: databases from 0.2.0 are backed up and recreated, not migrated.
- OpenAI and Google batch adapters are not included; they are planned for 0.4.0.
