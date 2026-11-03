# `harness-dsl`

A TypeScript DSL for durable agent harnesses. You declare what work exists (kinds with states), who does it (roles in seats on model pools), how (flows as a tree of named steps: commands, seats, jobs, halts, loops), where it queues (lanes with retry, reactions and a scheduler), what watches it (triggers over the event stream, metrics folded from it), and who may touch it (clients with typed grants, observers). The engine records every effect on a ledger and replays from it: a harness that dies mid-step resumes the same attempt, reruns only what its `effect` allows, asks the driver about an agent that finished while it was down, and finds decisions that landed in the meantime.

---

## Install

```bash
pnpm add harness-dsl zod
```

Node.js 22 or later. The provider SDKs are optional peers, loaded the first time a preset creates a model: `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai`. The Claude Code and Gemini CLI adapters need those CLIs installed and signed in.

---

## Quickstart

```ts
// harness.ts
import { H, processResolver, z } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';
import { sqlite } from 'harness-dsl/sqlite';

// Work: a kind with its states. Positions (pending, waiting, terminal) are declared, never inferred.
const Open = H.state('Open', 'pending');
const Done = H.terminal('Done', 'success');
const Rejected = H.terminal('Rejected', 'failure');
const Fix = H.kind('Fix')
  .attributes(z.object({ id: z.string(), title: z.string() }))
  .states(Open, Done, Rejected)
  .key((a) => a.id)
  .initial(Open);

// Accounts draw on a quota partition shared by every harness that names it.
const quota = sqlite.quota('claude', { path: '.harness/quota.sqlite' });
// A subscription signs in through an OAuth token, at a Claude Code configuration directory, or through the CLI's default sign-in.
const max = claudeCode.subscription('max', { token: H.env('CLAUDE_MAX_TOKEN'), quota });
const second = claudeCode.subscription('second', { configDir: H.env('CLAUDE_CONFIG_DIR_2'), quota });
// H.env('ANTHROPIC_API_KEY', { index: 1 }) names the second of a variable's comma-separated values.
const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-5-5' });
const subs = H.pool('subs').accounts(max, second);

// A role is a typed contract; a seat is role × model × pool.
const builderRole = H.role('builder')
  .input(z.object({ title: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt((i) => `Fix: ${i.title}. Run the checks before you stop.`)
  .intents('read', 'edit', 'run');
const builder = H.seat('builder').role(builderRole).model(sonnet).pool(subs);

// Commands run on a runner; `effect` says what a rerun after a crash may do.
const runner = local.runner('local', { maxConcurrentSlots: 2 });
const checks = H.command('checks').argv(['pnpm', 'test']).runner(runner).effect('repeatable');
const approval = H.halt('approval').decision(z.object({ approved: z.boolean() }));

// A flow is a tree of named steps. Every step has an address the ledger memoises.
const fix = H.flow('fix')
  .input(Fix.attributeSchema!)
  .step('build', builder, (ctx) => ({ title: ctx.unit.attributes.title }))
  .step('checks', checks)
  .halt('approval', approval, { ask: (ctx) => `merge ${ctx.unit.attributes.id}?`, timeout: { afterMinutes: 240, decide: () => ({ approved: false }) } })
  .exit('rejected', (ctx) => !ctx.steps.approval.approved)
  .exit('done');

// A lane queues units of one kind through one flow and maps its exits to states.
const fixes = H.lane('fixes', Fix)
  .supply(H.operator)
  .handler(fix, { exits: { done: Done, rejected: Rejected } })
  .retry({ tries: 2, backoff: 'exponential', exhausted: Rejected })
  .on(H.cancel, { enter: Rejected });

export const harness = H.harness('demo')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(fixes)
  .scheduler(H.scheduler('s').standard(fixes).wip(fixes, 1))
  .clients(claudeCode.supervisor('owner', { port: 4100, grants: [H.ops.work.create, H.ops.work.read, H.ops.resolve(approval), H.ops.telemetry.read] }))
  .observers(markdown.board('board', { path: '.harness/BOARD.md' }));

export const drivers = [claudeCode.driver({ workDir: process.cwd() })];
export const resolver = processResolver();
```

```bash
harness start ./harness.js          # validates, claims the ledger, serves the clients, ticks
harness status ./harness.js         # the board in text
harness install --launchd ./harness.js
```

A Claude Code session connects through the supervisor's `.mcp.json` (`claudeCode.session('owner', { endpoints: [supervisor] }).write(dir, resolver)`) and calls `work_create`, `halts_resolve`, `telemetry_read` as tools.

---

## Concepts

- **Unit, kind, state, position.** A unit of work has a kind, a key, attributes and one state at a time. States declare their position (`pending`, `waiting`, `terminal` with a verdict); `active` is the running attempt. The scheduler and the board read positions, never kinds.
- **Attempt and replay.** An attempt walks the flow tree. Every step output, decision, metric read, loop iteration and job handle is recorded under its address. On `start()` an open attempt is replayed from the top at no cost; the step that was running follows its `effect` (`repeatable`, `unrepeatable`, `external` with `detect`), a seat step asks the driver's `session`, a job is collected from its handle. A changed flow blocks the attempt with `definitionChanged`.
- **Lane and demand.** A lane has a supplier (a webhook, a poll, the operator), a handler flow with an exit map, retry with a typed end state (`exhausted` terminal, or waiting with `reopenAfter`; none leaves the attempt blocked for a supervisor), reactions to signals (`update`, `rewind`, `enter`, gated `at` steps), a lease and a cost ceiling. The scheduler grants demand per tick: WIP, pause, expedite holds, fixed dates, aging, admission policies.
- **Seat, pool, quota.** A seat is a role, a model (or a model policy, `distinct` across seats), and a pool of accounts with a drain policy and a fallback. Each account names a quota partition; every harness on it folds everyone's windows and cooldowns and its own share. A refused call rotates to the next account; none left blocks the step on `budget` until the soonest reset.
- **Halts.** A halt is a typed question. It is asked at an address, resolved by a client whose grant names it, by a policy (`skip`), or by a clock (`timeout`); `escalate` runs an executable after a delay. A decision is recorded with its facets, so decision metrics slice without a join.
- **Triggers and metrics.** Triggers consume ledger events once each (transitions, patterns, timers, steps, decisions, invocations, metric crossings with hysteresis per facet) and produce effects: create, signal, pause, resume, record, run. Metrics fold at read time with sample counts; a flow reads one through a `read` node.
- **Memory.** Journals hold items in a store that never ranks; the journal's recall policy chooses by specificity, track record and similarity, and the choice rides on the invocation. Items a role records enter as candidates.
- **Clients and observers.** A client serves the control API with the operations its grants name. An observer subscribes to the event stream; it is never a side effect of a write.
- **Guards.** A guarded seat step leases the workspace areas the agent writes (through the agent's hook protocol) and runs a `beforeStop` check; a failing check blocks the stop with its output.

---

## The DSL, `H.*`

| Builder | Declares |
| :-- | :-- |
| `H.state(name, 'pending' \| 'waiting')`, `H.terminal(name, verdict)` | states with positions |
| `H.kind(name).attributes(schema).states(...).key(fn).initial(state)` | a kind of work |
| `H.signal(name).payload(schema)`, `H.cancel` | signals a lane reacts to |
| `H.halt(name).decision(schema)` | a question with a typed decision |
| `H.resource(name)`, `H.resources(name, values)`, `H.facet(name, values)` | lease targets and metric dimensions |
| `H.role(name).input().output().prompt().intents(...)` | what a seat does |
| `H.memory(name, trust)`, `H.journal(name, kind).store().recall(policy).readBy().recordedBy()` | memory |
| `H.pool(name).accounts(...).drain(policy).fallback(account)` | accounts for seats |
| `H.seat(name).role().model(model \| policy).pool()` | a role in a seat |
| `H.command(name).input().output().argv(fn).runner(runner \| policy).acceptExitCodes().effect()` | a shell command |
| `H.job(name, { submit, collect, pollEveryMinutes })`, `H.batch(name, seat)` | remote work collected later |
| `H.flow(name).input().params().step().halt().read().spawn().wait().when().parallel().loop().exit()` | the tree |
| `H.lane(name, kind).supply().handler(flow, { exits }).store().retry().lease().after().on(signal, reaction).ceiling()` | a queue |
| `H.trigger(name).on(H.when.transition \| pattern \| timer \| step \| decision \| invocation \| crossing).do(fn)` | reactions to events |
| `H.metric(name, source).samples(fn)` / `.amounts(fn)` | a rate or a total |
| `H.policy.model \| account \| runner \| halt \| recall \| admit` | registered, recorded decisions |
| `H.scheduler(name).standard().fixedDate().expedite().wip().aging().admit()` | demand |
| `H.ops.*`, `H.operation(name, executable)` | grants and custom operations |
| `H.harness(name).ledger().lanes().journals().triggers().metrics().scheduler().clients().observers().share(account, fraction)` | the whole |

`validate(harness)` returns the problems `start()` would refuse on (22 rules: names, exits, states, retries, lanes, reactions, seats and pools, batches and hooks, workspaces, grants and halts, metrics, partitions, commands, triggers, loops, branches).

---

## Adapters

| Import | Provides |
| :-- | :-- |
| `harness-dsl/sqlite` | `sqlite.ledger({ path })`, `sqlite.quota(name, { path })` |
| `harness-dsl/claude-code` | `claudeCode.subscription`, `.model`, `.driver` (hooks, sessions), `.supervisor` (MCP), `.session` (`.mcp.json`) |
| `harness-dsl/anthropic` | `anthropic.account`, `.model` (batch), `.driver` over the AI SDK with the Message Batches API |
| `harness-dsl/google` | `google.account`, `.model` (batch), `.driver` over the AI SDK with Gemini batch mode |
| `harness-dsl/openrouter` | `openrouter.account`, `.model` (batch), `.driver` over the OpenAI-compatible API with OpenRouter's batch endpoint |
| `harness-dsl/gemini-cli` | `geminiCli.account`, `.model`, `.driver` (hooks, sessions) |
| `harness-dsl/http` | `http.controlApi(name, { port, token, grants })`: `/operations`, `/operations/<name>`, `/events` |
| `harness-dsl/markdown` | `markdown.board`, `markdown.telemetry` observers |
| `harness-dsl/slack` | `slack.observer(name, { webhook })` |
| `harness-dsl/local`, `harness-dsl/ssh` | `local.runner`, `ssh.host` runners with slots and ports |
| `harness-dsl/git` | `git.worktree(name, { repo, root? })` workspaces, one worktree per attempt |
| `harness-dsl/jsonl` | `jsonl.memoryStore(name, { path })` |
| `harness-dsl/kernel` | the contracts a backend implements: `Ledger`, `QuotaPartition`, `Store`, `MemoryStore`, `Supplier`, `ModelDriver`, `RunnerBackend`, `WorkspaceBackend`, `Client`, `Observer`, `Resolver` |

---

## The control API

Operations, each with a JSON schema a client publishes: `work.create | read | update | cancel | signal`, `attempts.recover`, `lanes.pause | resume`, `halts.resolve`, `memory.read | write | curate`, `telemetry.read`, `accounts.read | share`, and `custom.<name>` from `H.operation`. A client calls only what its grants name; `halts.resolve` only the halts its grant lists. Every write records who called it.

---

## Development

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm db:generate   # a new ledger or quota migration after a schema change
```

The core (`src/kernel`, `src/dsl`, `src/engine`) imports no adapter and names no provider; `test/unit/core-boundary.test.ts` enforces it.
