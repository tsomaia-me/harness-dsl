# Harness DSL (`harness-dsl`) — Product Specification

## §0. Purpose & Design Principles

`harness-dsl` (exported under the namespace `H`) is a domain-agnostic TypeScript framework for declaring, executing, and observing deterministic workflows with LLMs in the loop.

1. **Zero Domain Opinions in Core:** The framework core knows nothing about specific project roles ("Builder", "Auditor", "Visual Judge", "Arbiter"), project artifacts ("PRs", "Screens"), or programming languages. It provides the declarative primitives (`H.account`, `H.pool`, `H.model`, `H.runner`, `H.command`, `H.skill`, `H.agent`, `H.flow`, `H.head`) to compose any workflow. Project-specific patterns live in userland orchestrator packages or optional first-party plugins (`harness-dsl/plugins`).
2. **Everything Is a Stateless, Typed Descriptor:** Every construct created with `H.*` is an immutable, stateless blueprint backed by Zod input and output schemas. Any `Executable<TInput, TOutput>` (`H.command`, `H.agent` bound to an `H.skill`, or sub-`H.flow`) can be wired into a pipeline step, a conditional branch, a loop, a batch job, an agent tool, or an MCP tool exposed to `Head`.
3. **Deterministic State Machine Outside, Bounded LLMs Inside:** Workflow state, loops, retries, file leases, process lifecycles, and quota scheduling are executed deterministically by the Node.js runtime backed by SQLite. LLMs are invoked strictly as stateless or bounded-context functions that return Zod-validated outputs.
4. **Provider & Transport Agnostic:** Workflows bind to `H.model`, never to a hardcoded vendor CLI or SDK. A model can run over a multi-account CLI subscription pool (`claude -p`), a real-time SDK (`@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai`), a cloud Batch API (50% discount), or a custom user function without changing a single line of flow logic. Every provider-, CLI- and project-specific detail (rate-limit headers, quota windows, prices, hook formats, transcript formats, port names) sits behind an adapter with a first-party default, so the core never names a vendor.
5. **Independent Per-Project Orchestrators:** Each project runs its own independent orchestrator process, SQLite database (`.harness/runtime.db`), and local MCP endpoint (`.mcp.json`). Projects share multi-account subscription pools safely via declarative quota caps (`.maxQuotaShare()`).

---

## §1. Core Primitives & The `H.*` DSL Surface

### §1.1 Accounts & Pools (`H.account`, `H.pool`)

Both `H.account` and `H.pool` implement the `AccountProvider` interface (Composite pattern). Anywhere an `AccountProvider` is accepted (such as `H.model`), either a single `H.account` or an `H.pool` may be passed.

- **Reactive Quota & Reset Discovery:** Accounts do not require hardcoded reset schedules. Each account tracks the quota windows its provider reports, by id (`anthropic:5h` and `anthropic:7d` for Claude subscriptions, `openai:requests` / `openai:tokens`, `anthropic:requests`, `http:ratelimit`, ...), each with a utilization ratio and an exact `resetsAt`. Drivers extract them reactively from response headers (through a `RateLimitAdapter`), the Claude CLI's stream-json rate-limit events, quota probes and `429` responses. If a provider grants an early or bonus reset, the next run's report or probe that shows the share window's utilization dropping (or its reset moving later) frees the project share and returns the account to rotation immediately. A window reported without a reset time stops blocking once it goes stale. An account that fails authentication (logged out, expired token, invalid key) is taken out of rotation for a while and shown as unavailable on the board, and the pool fails over.
- **Reserve (`.reserve({ minFreeAccounts, maxBurstUtilization })`):** Keeps the `minFreeAccounts` least-used eligible accounts below `maxBurstUtilization` untouched. The pool uses its other eligible accounts first, then the fallback, and a reserved account only when neither is available.
- **Quota Policy (`.quotaPolicy({...})`):** Per-window thresholds, the probe staleness, the token budget that turns token use into project share, the window whose reset frees the share, and the default cooldown come from a `QuotaPolicy`: core defaults, overridden by the driver (the Claude CLI driver supplies the subscription values) and then by `H.account(...).quotaPolicy({...})`.
- **Per-Account and Per-Pool Quota Shares (`.maxQuotaShare(ratio)`):**
  - Declared on an individual `H.account`, `.maxQuotaShare(0.75)` caps this project's consumption of that specific account at 75% of its window.
  - Declared on an `H.pool`, `.maxQuotaShare(0.60)` sets the default cap for accounts in the pool (an individual account cap can only tighten the pool cap).

```typescript
import { H, z } from 'harness-dsl';

const AcctMain    = H.account('claude-main',    H.drivers.claudeCli({ configDir: '~/.claude' })).maxQuotaShare(0.75);
const AcctGoogle  = H.account('claude-google',  H.drivers.claudeCli({ configDir: '~/.claude-google' })).maxQuotaShare(0.75);
const AcctSession = H.account('claude-session', H.drivers.claudeCli({ configDir: '~/.claude-session' })).maxQuotaShare(0.20);
const AcctApi     = H.account('anthropic-api',  H.drivers.aiSdk({ provider: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' }));

export const ComputePool = H.pool('primary-pool', [AcctMain, AcctGoogle, AcctSession])
  .maxQuotaShare(0.60)
  .strategy('drain-soonest-expiring') // 'drain-soonest-expiring' | 'least-used' | 'priority' | 'round-robin'
  .reserve({ minFreeAccounts: 1, maxBurstUtilization: 0.50 })
  .fallback(AcctApi);
```

### §1.2 Models (`H.model`)

`H.model(accountOrPool, modelId, options?)` binds an `AccountProvider` to a model identifier and provider-specific configuration flags.

```typescript
export const Opus   = H.model(ComputePool, 'claude-opus-4-6',   { effort: 'high' });
export const Sonnet = H.model(ComputePool, 'claude-sonnet-4-6', { effort: 'high' });
export const Haiku  = H.model(AcctApi,     'claude-haiku-4-5',  { cachePrefix: true });
export const Gemini = H.model(
  H.account('gemini', H.drivers.aiSdk({ provider: 'google', apiKeyEnv: 'GEMINI_API_KEY' })),
  'gemini-2.5-pro',
  { thinkingBudget: 8192 }
);
```

Custom drivers are supported via `H.drivers.custom({ invoke, probeQuota?, batch? })`, allowing any CLI binary or HTTP API to back an `H.model`. `H.drivers.aiSdk({ provider })` also accepts a `ProviderPreset` (`{ name, createModel, apiKeyEnv?, mapModelOptions?, rateLimits?, pricing?, createBatch? }`), so any Vercel AI SDK model (Bedrock, Mistral, OpenRouter, Ollama) runs without core changes.

Token costs come from a `PricingAdapter`: dated first-party price lists for Anthropic, OpenAI and Google, and the cost the Claude CLI itself reports. `H.model(...).pricing(adapter)` overrides it per model, on every path including batch, and takes precedence over a provider-reported cost. A model no price list knows is recorded as unpriced, never billed at a guessed rate.

### §1.3 Runners (`H.runner`)

`H.runner` defines where shell commands, tests, builds, and local/remote processes execute, with built-in concurrency control, load/disk guards, deterministic slot port allocation, and process-group termination.

```typescript
export const LocalRunner = H.runner.local({
  maxConcurrentSlots: 2,
  slotPortBase: 18000, // Slot 0: 18000-18009, Slot 1: 18010-18019
  timeoutMs: 10 * 60_000,
  inactivityTimeoutMs: 2 * 60_000,
});

export const Wb2Runner = H.runner.ssh('wb2', {
  host: 'wb2',
  workDir: '/srv/harness/CrookedDuke',
  maxConcurrentSlots: 2,
  maxCpuLoadRatio: 1.5,
  minFreeDiskGb: 10,
  slotPortBase: 18100,
  timeoutMs: 15 * 60_000,
  inactivityTimeoutMs: 3 * 60_000,
});
```

- **Slot Environment:** Each command gets `HARNESS_SLOT` and `PORT` (the slot's first port). Project-specific port names come from `slotEnv: (slot, ports) => ({ PORT_API: String(ports[0]), ... })`, and `portsPerSlot` sets the range size (default 10).
- **Agentless SSH Execution:** `H.runner.ssh` requires no daemon installed on the remote host. It uses persistent SSH ControlMaster sockets, syncs git commits over LAN (`git push ssh://...`), and wraps remote commands in an isolated process group (`setsid` + `HUP` trap) so dropped connections or timeouts kill the entire remote process tree immediately.

### §1.4 Commands (`H.command`)

`H.command(name)` wraps a deterministic shell command or TypeScript function into a typed `Executable<TInput, TOutput>`.

```typescript
export const TouchedChecks = H.command('touched-checks')
  .input(z.object({ worktreePath: z.string(), sinceSha: z.string().optional() }))
  .output(z.object({ passed: z.boolean(), summary: z.string() }))
  .runner(LocalRunner)
  .envFrom('.env.test') // Optional: injected into command env, never read by LLMs
  .run(async ({ input, exec }) => {
    const flag = input.sinceSha ? `--since ${input.sinceSha}` : '';
    const res = await exec(`pnpm check:touched --direct ${flag}`, { cwd: input.worktreePath, reject: false });
    return { passed: res.exitCode === 0, summary: res.all.slice(-4000) };
  });
```

### §1.5 Skills (`H.skill`)

`H.skill(name)` is a pure contract specifying input schema, output schema, optional semantic assertion, and self-correction retry count. It owns no model, runner, or persona.

```typescript
export const AuditSkill = H.skill('audit-diff')
  .input(z.object({
    ticketId: z.string(),
    criteria: z.array(z.object({ id: z.string(), text: z.string() })),
    diff: z.string(),
    overruledIds: z.array(z.string()).default([]),
  }))
  .output(z.object({
    criteria: z.array(z.object({
      id: z.string(),
      met: z.boolean(),
      evidenceOrDeficit: z.string(),
    })),
    breakOnce: z.object({ passed: z.boolean(), detail: z.string() }),
  }))
  .assert((out, input) => {
    const returnedIds = new Set(out.criteria.map((c) => c.id));
    for (const c of input.criteria) {
      if (!returnedIds.has(c.id)) throw new Error(`Missing verdict for criterion ${c.id}`);
    }
  })
  .maxRetries(2);
```

### §1.6 Agents (`H.agent`)

`H.agent(name)` declares an LLM actor's model, system instructions, allowed tools, context ceiling, hooks, and lesson filters. Binding an agent to a skill via `agent.run(skill, inputMapper?)` returns an `Executable<TInput, TOutput>`.

```typescript
export const Builder = H.agent('builder')
  .model(Opus)
  .maxContextTokens(250_000)
  .promptFile('.harness/prompts/builder.md')
  .tools(['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'LSP'])
  .tool('explore_repo', RepoExplorer.run(ExploreSkill)) // Composable agent-as-tool
  .use(stopCommandHook(TouchedChecks, {                  // Opt-in plugin hook
    mapInput: ({ workDir }) => ({ worktreePath: workDir }),
  }))
  .use(fileLeaseGuard());                               // Opt-in file scope lock
```

- **Automatic Context Handoff:** If a multi-turn CLI agent approaches `maxContextTokens` (at `maxContextTokens - handoffBuffer`, where `.handoffBuffer(tokens)` defaults to `30_000`; more than `.maxHandoffs(n)` consecutive handoffs, default 3, fail the step), the driver injects a handoff turn instructing the agent to commit its progress and output a structured state summary, then transparently spawns a fresh successor session on the same worktree to finish the remaining criteria.

### §1.7 Flows & Combinators (`H.flow`)

`H.flow(name)` composes any combination of `H.command`, `H.agent.run(skill)`, and nested `H.flow` descriptors into a strongly-typed state machine.

| Combinator | Signature / Behavior |
| :--- | :--- |
| `.input(schema)` | Declares the Zod schema for `ctx.input`. |
| `.identify({ ticketId?, touchedPaths? })` | Names which input values are the run's ticket id (shown on the board) and touched file paths (used to filter lessons). The engine reads no input field unless the flow names it here. |
| `.step(name, exec, mapInput?)` | Runs `exec`, validates output via Zod, and assigns it to `ctx.steps[name]`. |
| `.when(predicate, execOrSubflow)` | Executes the step/subflow only if `predicate(ctx)` is truthy; types `ctx.steps[name]` as `TOutput \| undefined`. |
| `.branch(selector, map)` | Routes execution to `map[selector(ctx)]`. |
| `.parallel(record)` | Runs multiple named executables concurrently and merges their typed outputs into `ctx.steps`. |
| `.loop({ maxIterations, body, until })` | Executes `body(flow)` repeatedly until `until(ctx)` returns `true` or `maxIterations` is reached. Exposes `ctx.iteration` and `ctx.prev` (previous iteration's step outputs). |
| `.batch(name, { items, execute, concurrency? })` | Maps `items(ctx)` through `execute`. Uses the model driver's native 50%-off Cloud Batch API when available, or a bounded local queue (`p-queue`) otherwise. |
| `.haltIf(predicate, mapBlocker)` | Pauses the flow run in SQLite with status `BLOCKED`, notifies `Head` via MCP, and resumes from the exact step once resolved via `blocker_resolve`. |
| `.onError(handler)` / `.finally(exec)` | Structured error recovery and guaranteed cleanup (e.g., releasing worktrees/ports). |

### §1.8 The `Head` Bridge (`H.head`)

`H.head()` configures the built-in MCP server (`@modelcontextprotocol/sdk`) hosted by the project's orchestrator daemon on `http://127.0.0.1:<port>/mcp`. On startup, the daemon automatically writes `.mcp.json` in the project root so any Claude session started in the project connects to it automatically.

```typescript
export type HeadCapability =
  | 'workflows:read'
  | 'workflows:control'
  | 'tickets:read'
  | 'tickets:write'
  | 'blockers:resolve'
  | 'lessons:manage'
  | 'accounts:manage'
  | 'telemetry:read'
  | 'runner:exec';

export const Head = H.head()
  .capabilities([
    'workflows:read',
    'workflows:control',
    'tickets:read',
    'tickets:write',
    'blockers:resolve',
    'lessons:manage',
    'accounts:manage',
    'telemetry:read',
  ])
  .contextNoticeThreshold(180_000)
  .tool('explore_repo', RepoExplorer.run(ExploreSkill))
  .tool('prod_health', ProdHealthCommand);
```

- **Grounding & Rotation (`harness_ground` / `harness_handoff`):**
  - `.claude/skills/head/SKILL.md` instructs `Head` to call `harness_ground()` as its first step.
  - `harness_ground()` registers `Head`'s session, returns live queue/blocker/account state, any note from the prior `Head`, and `head`-scoped lessons.
  - A `PostToolUse` hook on `mcp__harness__*` reads `Head`'s `transcript_path` token usage on every MCP tool call. When usage crosses `contextNoticeThreshold`, the MCP response instructs `Head` to call `harness_handoff({ note })` and compact or rotate.
  - Hook callbacks from agents and `Head` go through a `HookProtocol` that builds the agent's hook settings, parses callbacks into neutral tool events, formats the answers and measures transcripts. Each driver brings its agents' protocol (`claude-code` for the Claude CLI), and each invocation registers its plugins with the orchestrator, so batch items and parallel agents keep their own guards. An agent with plugins refuses to run where hooks cannot be delivered. `.headProtocol(protocol)` sets the protocol the Head's own client speaks (default `claude-code`); the Head's MCP config (`.mcp.json`) and its `PostToolUse` hook currently assume Claude Code.

---

## §2. Scoped Lessons Ledger (`.harness/lessons.jsonl`) & Separation from `.claude/`

### §2.1 Separation Between `.claude/` and `H.*`
1. **`CLAUDE.md` & `.claude/rules/*.md`:** Hold static codebase knowledge (architecture boundaries, coding style, test conventions). Zero orchestration or role rules live here, so interactive sessions run cleanly without builder hook interference.
2. **Orchestrator Ephemeral Injection:** When the orchestrator spawns an agent, it passes role instructions, filtered lessons, tool whitelists, and `Stop`/`PreToolUse` hooks dynamically via CLI flags (`--settings <tmp.json>`, `--append-system-prompt`, `--allowedTools`, `--strict-mcp-config`).

### §2.2 Single `.harness/lessons.jsonl` Ledger
All learned rules for a project live in a single git-tracked `.harness/lessons.jsonl` file. Each line is validated against:

```typescript
const LessonSchema = z.object({
  id: z.string(),
  kind: z.enum(['domain', 'behavioral']),
  roles: z.array(z.string()), // e.g. ['builder', 'auditor'] or ['*']
  paths: z.array(z.string()), // picomatch globs, e.g. ['apps/admin/**'] or ['**']
  rule: z.string(),           // "Do X, because Y."
  createdAt: z.string(),
});
```

When launching an agent, the orchestrator filters `lessons.jsonl` in memory by matching `agent.name` against `roles` and the active task's file paths against `paths`, injecting only the relevant subset. `Head` manages `lessons.jsonl` through MCP tools (`lesson_add`, `lesson_widen`, `lesson_remove`), backed by an automatic similarity check so duplicate lessons are merged rather than appended.

---

## §3. State Projections & Telemetry (`.harness/BOARD.md` & `.harness/TELEMETRY.md`)

All mutable runtime state lives in `.harness/runtime.db` (SQLite, gitignored). On every state transition, the orchestrator synchronously projects two human-readable Markdown files:

1. **`.harness/BOARD.md`:**
   - Live account pool status: one column per quota window id with utilization % and `resetsAt` countdown, plus the project quota share.
   - Active, queued, blocked, and recently completed workflow runs with current round, active step, and context usage.
   - Open blockers with options and recommendations.
2. **`.harness/TELEMETRY.md`:**
   - Per-run breakdown: start/end timestamps, wall-clock duration, iterations taken, input/cached/output tokens, **actual API \$ spent**, and **subscription API-equivalent \$ value**. Invocations of an unpriced model show `—`, and totals that include them say `+ unpriced`.
   - Per-agent scorecard: first-round pass rate, catch rate, average duration, and token efficiency.

---

## §4. Complete Userland Composition Example (Builder + Auditor + Opt-In Dispute Arbiter)

```typescript
import { H, z } from 'harness-dsl';
import { gitWorktreeIsolation, fileLeaseGuard, stopCommandHook } from 'harness-dsl/plugins';
import { Opus, Sonnet, LocalRunner, Wb2Runner, ComputePool, Head } from './infra.js';

const CriterionSchema = z.object({ id: z.string(), text: z.string() });
const DisputeSchema = z.object({ criterionId: z.string(), citation: z.string(), reason: z.string() });

const TicketInput = z.object({
  id: z.string(),
  title: z.string(),
  surface: z.enum(['edge', 'admin', 'app', 'shared']),
  touches: z.array(z.string()),
  criteria: z.array(CriterionSchema),
});

const BuildSkill = H.skill('build')
  .input(z.object({
    ticket: TicketInput,
    priorDeficits: z.array(CriterionSchema),
    lockedIds: z.array(z.string()),
  }))
  .output(z.object({
    status: z.enum(['READY', 'NEEDS_OWNER']),
    question: z.string().optional(),
    touchedUi: z.boolean(),
    disputes: z.array(DisputeSchema).default([]),
  }));

const ArbitrateSkill = H.skill('arbitrate')
  .input(z.object({
    disputes: z.array(DisputeSchema),
    deficits: z.array(CriterionSchema),
  }))
  .output(z.object({
    overruledIds: z.array(z.string()),
    rejectedIds: z.array(z.string()),
    contradiction: z.string().optional(),
  }));

const AuditSkill = H.skill('audit')
  .input(z.object({
    ticket: TicketInput,
    overruledIds: z.array(z.string()),
  }))
  .output(z.object({
    deficits: z.array(CriterionSchema),
    breakOncePassed: z.boolean(),
  }));

const Builder = H.agent('builder')
  .model(Opus)
  .maxContextTokens(250_000)
  .promptFile('.harness/prompts/builder.md')
  .tools(['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'LSP'])
  .use(fileLeaseGuard());

const Arbiter = H.agent('arbiter')
  .model(Opus)
  .promptFile('.harness/prompts/arbiter.md')
  .tools(['Read', 'Grep']);

const Auditor = H.agent('auditor')
  .model(Opus)
  .promptFile('.harness/prompts/auditor.md')
  .tools(['Read', 'Grep', 'Glob', 'Bash']);

export const ticketWorkflow = H.flow('ticket-flow')
  .input(TicketInput)
  .identify({ ticketId: (ticket) => ticket.id, touchedPaths: (ticket) => ticket.touches })
  .use(gitWorktreeIsolation({ baseBranch: 'origin/main' }))
  .loop({
    maxIterations: 3,
    body: (round) => round
      .step('build', Builder.run(BuildSkill, (ctx) => ({
        ticket: ctx.input,
        priorDeficits: ctx.prev?.audit.deficits ?? [],
        lockedIds: ctx.prev?.arbitrate?.rejectedIds ?? [],
      })))
      .haltIf(
        (ctx) => ctx.steps.build.status === 'NEEDS_OWNER',
        (ctx) => ({ reason: ctx.steps.build.question ?? 'Builder requested owner decision' })
      )
      .when(
        (ctx) => ctx.steps.build.disputes.length > 0,
        (sub) => sub
          .step('arbitrate', Arbiter.run(ArbitrateSkill, (ctx) => ({
            disputes: ctx.steps.build.disputes,
            deficits: ctx.prev?.audit.deficits ?? [],
          })))
          .haltIf(
            (ctx) => Boolean(ctx.steps.arbitrate?.contradiction),
            (ctx) => ({ reason: `Spec contradiction: ${ctx.steps.arbitrate?.contradiction}` })
          )
      )
      .step('audit', Auditor.run(AuditSkill, (ctx) => ({
        ticket: ctx.input,
        overruledIds: ctx.steps.arbitrate?.overruledIds ?? [],
      }))),
    until: (ctx) => ctx.steps.audit.deficits.length === 0 && ctx.steps.audit.breakOncePassed,
  });
