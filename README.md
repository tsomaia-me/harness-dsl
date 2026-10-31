# `harness-dsl`

Strongly-typed TypeScript orchestration DSL (`H.*`) for composing deterministic shell commands, schema-validated AI agent skills, reactive multi-account subscription/API pools, and an interactive Head MCP server.

---

## Features

- **Unified `Executable<TInput, TOutput>` Contract** — Deterministic commands (`H.command`), bound agent skills (`Agent.run(Skill)`), and sub-flows (`H.flow`) share a single Zod-validated interface and compose interchangeably across all flow combinators.
- **Strongly-Typed Flow Combinators** — `.step()`, `.when()`, `.branch()`, `.parallel()`, `.loop()`, `.batch()`, `.haltIf()`, `.onError()`, and `.finally()` propagate step output types through `ctx.steps` and `ctx.prev` at compile time.
- **Reactive Multi-Account Quota Pools (`H.pool`)** — Pool multiple Claude CLI subscription accounts (`CLAUDE_CONFIG_DIR`) and API keys (`@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai`) with per-account and per-pool quota share ceilings (`maxQuotaShare`), provider-neutral quota windows (Claude 5h/7d, OpenAI requests/tokens, IETF `RateLimit-*`) read from headers and CLI rate-limit events, per-window thresholds via `.quotaPolicy()`, 429 cooldown failover, reserve thresholds, and API fallback.
- **50% Discount Cloud Batching (`H.batch`)** — Automatically routes multi-item batch steps to the Anthropic Message Batches API (`/v1/messages/batches`) with prompt caching when backed by an `ai-sdk` Anthropic driver, or executes concurrently via `p-queue` for CLI/command steps.
- **Process-Group & SSH Containment (`H.runner`)** — Local and agentless SSH runners (`ControlMaster` multiplexing + `setsid` process groups) with deterministic per-slot port allocation (`HARNESS_SLOT`, `PORT`, plus your own names through `slotEnv`), inactivity watchdogs, and remote CPU/disk pre-flight health checks.
- **Scoped Institutional Memory (`.harness/lessons.jsonl`)** — Append-only JSONL lesson store with Jaccard similarity deduplication, filtered automatically by agent role and `picomatch` file globs before prompt injection.
- **First-Party Plugins (`harness-dsl/plugins`)** — Git worktree isolation per run (`gitWorktreeIsolation`), cross-run exclusive file leases (`fileLeaseGuard`), and mechanical verification gates on agent completion (`stopCommandHook`).
- **Streamable HTTP MCP Server (`H.head` & `startOrchestrator`)** — Exposes live queue, blocker resolution, ticket CRUD, lesson management, quota share controls, telemetry, and custom agent/command tools to your interactive Claude Code Head session over `/mcp`.

---

## Installation

```bash
pnpm add harness-dsl zod
```

Requires **Node.js >= 22**.

---

## Quickstart

```ts
import { H, startOrchestrator, z } from 'harness-dsl';
import {
  fileLeaseGuard,
  gitWorktreeIsolation,
  stopCommandHook,
} from 'harness-dsl/plugins';

const SubsPool = H.pool('claude-subs', [
  H.account('sub-1', H.drivers.claudeCli({ configDir: '~/.claude' })).maxQuotaShare(0.5),
  H.account('sub-2', H.drivers.claudeCli({ configDir: '~/.claude-2' })).maxQuotaShare(0.8),
])
  .strategy('drain-soonest-expiring')
  .fallback(
    H.account('api-fallback', H.drivers.aiSdk({ provider: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' })),
  );

const Opus = H.model(SubsPool, 'claude-opus-4-6');
const Sonnet = H.model(SubsPool, 'claude-sonnet-4-6');

const VerifyGate = H.command('verify-gate')
  .input(z.any())
  .output(z.object({ passed: z.boolean(), summary: z.string() }))
  .run(async ({ ctx, exec }) => {
    const res = await exec('pnpm typecheck && pnpm test', { cwd: ctx.workDir, reject: false });
    return { passed: res.exitCode === 0, summary: res.all.slice(-2000) };
  });

const BuildSkill = H.skill('implement-ticket')
  .input(z.object({ id: z.string(), instructions: z.string(), deficits: z.array(z.string()) }))
  .output(
    z.object({
      status: z.enum(['READY', 'NEEDS_OWNER']),
      question: z.string().optional(),
      summary: z.string(),
    }),
  );

const AuditSkill = H.skill('audit-ticket')
  .input(z.object({ id: z.string(), summary: z.string() }))
  .output(z.object({ approved: z.boolean(), deficits: z.array(z.string()) }));

const Builder = H.agent('builder')
  .model(Opus)
  .maxContextTokens(250_000)
  .prompt('Implement the ticket cleanly with tests.')
  .tools(['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'])
  .use(fileLeaseGuard())
  .use(stopCommandHook(VerifyGate));

const Auditor = H.agent('auditor')
  .model(Sonnet)
  .prompt('Audit the implementation against the ticket requirements.')
  .tools(['Read', 'Grep', 'Glob', 'Bash']);

const TicketFlow = H.flow('ticket-flow')
  .input(z.object({ id: z.string(), instructions: z.string(), touches: z.array(z.string()) }))
  .identify({ ticketId: (ticket) => ticket.id, touchedPaths: (ticket) => ticket.touches })
  .use(gitWorktreeIsolation({ baseBranch: 'main', cleanupOnSuccess: true }))
  .loop({
    maxIterations: 3,
    body: (round) =>
      round
        .step(
          'build',
          Builder.run(BuildSkill, (ctx) => ({
            id: ctx.input.id,
            instructions: ctx.input.instructions,
            deficits: ctx.prev?.audit?.deficits ?? [],
          })),
        )
        .haltIf(
          (ctx) => ctx.steps.build.status === 'NEEDS_OWNER',
          (ctx) => ({ reason: ctx.steps.build.question ?? 'Clarification needed' }),
        )
        .step(
          'audit',
          Auditor.run(AuditSkill, (ctx) => ({
            id: ctx.input.id,
            summary: ctx.steps.build.summary,
          })),
        ),
    until: (ctx) => ctx.steps.audit.approved && ctx.steps.audit.deficits.length === 0,
  });

const Head = H.head()
  .port(4100)
  .capabilities([
    'workflows:read',
    'workflows:control',
    'blockers:resolve',
    'tickets:read',
    'tickets:write',
    'lessons:manage',
    'accounts:manage',
    'telemetry:read',
    'runner:exec',
  ])
  .registerFlow(TicketFlow);

const orchestrator = await startOrchestrator({
  projectDir: process.cwd(),
  head: Head,
});
```

---

## Core DSL Reference (`H.*`)

### 1. Accounts, Pools & Models

- **`H.drivers.claudeCli(opts)`**: Spawns `claude -p --output-format stream-json --json-schema` with isolated `configDir` (`CLAUDE_CONFIG_DIR`) or `CLAUDE_CODE_OAUTH_TOKEN`, automatic `--resume` on schema validation retry, 1-turn context-ceiling handoff extraction when `maxContextTokens - handoffBuffer` is reached, live 5h/7d windows from the CLI's `rate_limit_event`, and the CLI-reported cost as the subscription-equivalent value.
- **`H.drivers.aiSdk(opts)`**: Calls any Vercel AI SDK model with structured output (`Output.object`). `provider` is `'anthropic' | 'openai' | 'google'` or your own `ProviderPreset` (`{ name, createModel, apiKeyEnv?, mapModelOptions?, rateLimits?, pricing?, createBatch? }`); `fetch`, `rateLimits` and `pricing` options override the preset. First-party presets map `cachePrefix`, `effort` and `thinkingBudget`, parse their provider's rate-limit headers, and price tokens from dated price lists. Anthropic Cloud Batch is on by default; `batch: false` turns it off, and `anthropicBatchAdapter({ ... })` configures `maxTokens`, `apiVersion`, `discount` and `structuredOutput`.
- **`H.drivers.custom(opts)` / `H.drivers.mock(opts)`**: Custom or deterministic test drivers.
- **`H.account(id, driver).maxQuotaShare(0..1)`**: Wraps a driver with a per-account quota ceiling.
- **`H.account(id, driver).quotaPolicy({ thresholds?, defaultThreshold?, probeStalenessMs?, tokenBudget?, shareResetWindowId?, defaultCooldownMs? })`**: Overrides the driver's quota policy. Without a `tokenBudget`, project share is not derived from token use.
- **`H.pool(id, accounts)`**:
  - `.strategy('drain-soonest-expiring' | 'least-used' | 'round-robin' | 'priority')`
  - `.maxQuotaShare(0..1)`
  - `.reserve({ minFreeAccounts, maxBurstUtilization })`
  - `.fallback(accountProvider)`
- **`H.model(accountOrPool, modelId, options?)`**: Binds a model identifier and provider options (`{ effort, thinkingBudget, cachePrefix }`) to an account or pool. `.pricing(adapter)` overrides how its tokens are priced; a model no price list knows is recorded as unpriced.

### 2. Runners & Commands

- **`H.runner.local(opts?)`**: Concurrency-slotted local process runner with deterministic port allocation (`slotPortBase + slot * portsPerSlot`, default 10 ports per slot), `HARNESS_SLOT` / `PORT` plus `slotEnv(slot, ports)` names in each command's env, and process-tree kill on timeout or inactivity.
- **`H.runner.ssh(id, opts)`**: Agentless remote SSH runner using OpenSSH `ControlMaster` multiplexing, remote `setsid` process groups, pre-flight CPU load and disk space checks (`RunnerLoadHighError`, `RunnerDiskLowError`), and `syncGitRef()` worktree pushing.
- **`H.command(name)`**:
  - `.input(zodSchema)` / `.output(zodSchema)`
  - `.runner(runnerInstance)`
  - `.envFrom('.env.file')`
  - `.run(async ({ input, ctx, exec }) => output)`

### 3. Skills & Agents

- **`H.skill(name)`**:
  - `.input(zodSchema)` / `.output(zodSchema)`
  - `.prompt(templateOrFn)`
  - `.assert(async (output, input) => { ... })` — Semantic assertion; throwing triggers an automatic in-session `--resume` retry with feedback.
  - `.maxRetries(n)`
- **`H.agent(name)`**:
  - `.model(modelDef)`
  - `.maxContextTokens(n)` / `.handoffBuffer(tokens)` (default 30_000) / `.maxHandoffs(n)` (default 3) / `.inactivityTimeoutMs(ms)`
  - `.prompt(text)` / `.promptFile(filePath)`
  - `.tools(['Read', 'Edit', ...])` — Built-in tool allowlist.
  - `.tool(name, executable)` — Attaches any `Executable` (command, agent skill, or flow) as an MCP tool callable by the agent.
  - `.use(plugin)` — Attaches hook plugins (`preTool: { intents, handle }` / `stop: { handle }`), delivered through the driver's `HookProtocol`. Each invocation registers its plugins with the orchestrator; an agent with plugins refuses to run on a driver without a hook protocol or outside `startOrchestrator`.
  - `.run(skillDef, inputMapper?)` — Produces a `BoundAgentSkill` (`Executable<TInput, TOutput>`).

### 4. Flow Combinators (`H.flow(name)`)

- **`.input(zodSchema)`** — Validates flow input at entry.
- **`.identify({ ticketId?, touchedPaths? })`** — Names which input values are the run's ticket id and touched paths (for lesson filtering).
- **`.use(middleware)`** — Wraps the flow lifecycle (e.g., `gitWorktreeIsolation()`).
- **`.step(name, executable, mapInput?)`** — Runs an executable and merges `{ [name]: TOutput }` into `ctx.steps`.
- **`.when(predicate, subflowOrExecutable, mapInput?)`** — Conditional execution; subflow step outputs are typed as `Partial<...>`.
- **`.branch(selector, branchesMap)`** — Keyed routing across executables or subflows; all branch outputs are merged as optional properties on `ctx.steps`.
- **`.parallel(branchesMap)`** — Concurrent fan-out across executables and `H.when(...)` conditional branches.
- **`.loop({ maxIterations, body, until })`** — Iterative convergence loop; exposes `ctx.prev` from the prior iteration and resets conditional step keys between iterations so stale values never bleed forward.
- **`.batch(name, { items, execute, concurrency? })`** — Maps over an array of items via the driver's Cloud Batch adapter (Anthropic, 50% discount, when `items.length > 1`) or `p-queue`.
- **`.haltIf(predicate, mapBlocker?)`** — Persists flow state to SQLite (`status = 'blocked'`), updates `.harness/BOARD.md`, and suspends until `blocker_resolve` is called via MCP or `store.resolveBlocker()`.
- **`.onError(handler)` / `.finally(handler)`** — Error recovery and guaranteed cleanup hooks.

---

## First-Party Plugins (`harness-dsl/plugins`)

| Plugin | Scope | Description |
| :--- | :--- | :--- |
| `gitWorktreeIsolation({ baseBranch?, worktreesDir?, cleanupOnSuccess? })` | Flow (`.use()`) | Creates an isolated git worktree (`harness/<runId>`) per flow run and removes it on completion. |
| `fileLeaseGuard()` | Agent (`.use()`) | Subscribes to `file-write` tool events (Claude Code: `Edit`, `Write`, `MultiEdit`) and blocks writes to files leased by another active run. |
| `stopCommandHook(commandDef, { mapInput?, verdict? })` | Agent (`.use()`) | Runs a verification `CommandDef` with `{ workDir }` when an agent attempts to stop and blocks completion with its `summary` if `passed === false`. A command with another input needs `mapInput`, and one with another output needs `verdict(output) => ({ allow, reason })`; both are enforced by the types. |

---

## State, Memory & Markdown Projections

`HarnessStore` manages all state under `<projectDir>/.harness/`:

- **`.harness/runtime.db`** — SQLite WAL database (`workflow_runs`, `invocations`, `account_quotas`, `account_quota_windows`, `file_leases`, `head_sessions`), versioned with `PRAGMA user_version`; a database from another schema version is kept as `runtime.db.v<n>.bak` and a fresh one is created.
- **`.harness/lessons.jsonl`** — Git-committed scoped lessons (`domain` / `behavioral`), automatically deduplicated by token similarity and injected into matching agents' system prompts.
- **`.harness/tickets/*.md`** — Markdown tickets with YAML frontmatter parsed via `gray-matter`.
- **`.harness/BOARD.md`** — Auto-rendered live dashboard with one column per quota window (utilization and reset countdown), active/blocked runs, context token usage, and open blockers.
- **`.harness/TELEMETRY.md`** — Auto-rendered cost and token ledger with per-run breakdown and per-agent scorecard (first-pass rate, schema retries, actual API USD vs. subscription equivalent USD); unpriced models show `—`.

---

## Head MCP Server Tools

When `startOrchestrator({ projectDir, head })` starts, it writes `.mcp.json` in `projectDir` and serves `/mcp` over Streamable HTTP:

- **Always registered:** `harness_ground`, `harness_handoff`, plus any custom `.tool(name, executable)` registered on `H.head()`.
- **`workflows:read`:** `workflow_status`, `workflow_inspect_run`
- **`workflows:control`:** `workflow_start`, `workflow_pause`, `workflow_cancel`
- **`blockers:resolve`:** `blocker_list`, `blocker_resolve`
- **`tickets:read` / `tickets:write`:** `ticket_list`, `ticket_read`, `ticket_write`
- **`lessons:manage`:** `lesson_list`, `lesson_add`, `lesson_widen`, `lesson_remove`
- **`accounts:manage`:** `account_status`, `account_set_share`
- **`telemetry:read`:** `telemetry_summary`, `telemetry_runs`
- **`runner:exec`:** `runner_exec`

The same server is every run's hook receiver: agent hooks post to `/internal/hook?invocation=<id>`. `H.head().headProtocol(protocol)` sets how the Head's own client reports tool events and transcripts (default Claude Code), and `.contextNoticeThreshold(tokens)` sets when the Head is told to call `harness_handoff`. `.mcp.json` and the Head's `PostToolUse` hook currently assume Claude Code.

---

## Development & Verification

```bash
pnpm typecheck
pnpm build
pnpm test
node --env-file=.env ./node_modules/vitest/vitest.mjs run test/e2e
```
