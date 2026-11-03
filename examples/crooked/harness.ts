import path from 'node:path';
import { z } from 'zod';
import { claudeCode } from '../../src/adapters/claude-code/index.js';
import { git } from '../../src/adapters/git/index.js';
import { local } from '../../src/adapters/local/index.js';
import { markdown } from '../../src/adapters/markdown/index.js';
import { sqlite } from '../../src/adapters/sqlite/index.js';
import { H } from '../../src/dsl/index.js';
import type { ModelDriver } from '../../src/kernel/index.js';

/**
 * The product harness in 0.4.0 terms, after `.claude/docs/harness.md` of the product repo: lanes for
 * epics (which spawn their tickets in order), tickets (builder, then reviewer, verifier and judge in
 * parallel, fix rounds, the owner's sign-off, the merge), bugs (a hotfix with one check) and
 * heartbeats (the nightly journeys as a timer trigger). Tickets arrive through the operator here;
 * the Linear supplier and store are the next adapter. The owner's session is the supervisor client.
 */
export interface CrookedHarnessOptions {
  readonly repo: string;
  readonly stateDir: string;
  readonly models?: { readonly opus?: string; readonly sonnet?: string; readonly haiku?: string };
  readonly supervisorPort?: number;
}

export const Todo = H.state('Todo', 'pending');
export const Blocked = H.state('Blocked', 'waiting');
export const Merged = H.terminal('Merged', 'success');
export const Abandoned = H.terminal('Abandoned', 'failure');
export const Planned = H.state('Planned', 'pending');
export const Shipped = H.terminal('Shipped', 'success');
export const Cancelled = H.terminal('Cancelled', 'failure');
export const Due = H.state('Due', 'pending');
export const Passed = H.terminal('Passed', 'success');
export const FailedRun = H.terminal('Failed', 'failure');

export const ticket = z.object({ id: z.string(), title: z.string(), criteria: z.array(z.string()), sections: z.array(z.string()), rulings: z.array(z.string()), epic: z.string().optional() });
export const Ticket = H.kind('Ticket').attributes(ticket).states(Todo, Blocked, Merged, Abandoned).key((a) => a.id).initial(Todo);
export const epic = z.object({ id: z.string(), title: z.string(), tickets: z.array(ticket) });
export const Epic = H.kind('Epic').attributes(epic).states(Planned, Shipped, Cancelled).key((a) => a.id).initial(Planned);
export const bugReport = z.object({ id: z.string(), title: z.string(), repro: z.string() });
export const Bug = H.kind('Bug').attributes(bugReport).states(Todo, Merged, Abandoned).key((a) => a.id).initial(Todo);
export const heartbeat = z.object({ night: z.string() });
export const Heartbeat = H.kind('Heartbeat').attributes(heartbeat).states(Due, Passed, FailedRun).key((a) => a.night).initial(Due);

export const Areas = H.resources('area', ['app', 'api', 'admin', 'infra']);
export const signOff = H.halt('sign-off').decision(z.object({ merge: z.boolean(), note: z.string().optional() }));
export const needsYou = H.halt('needs-you').decision(z.object({ ruling: z.string() }));
export const triage = H.halt('bug-triage').decision(z.object({ fix: z.boolean() }));

const verdict = z.object({ blocking: z.array(z.string()), notes: z.array(z.string()) });
const builderInput = z.object({ title: z.string(), criteria: z.array(z.string()), sections: z.array(z.string()), rulings: z.array(z.string()), fixList: z.array(z.string()) });

export const builderRole = H.role('builder')
  .input(builderInput)
  .output(z.object({ sha: z.string(), checksRun: z.array(z.string()), deferred: z.array(z.string()), decisions: z.array(z.string()) }))
  .prompt((i) => [`Build ticket: ${i.title}.`, `Criteria:\n- ${i.criteria.join('\n- ')}`, `Design sections: ${i.sections.join(', ')}.`, i.rulings.length > 0 ? `Rulings:\n- ${i.rulings.join('\n- ')}` : '', i.fixList.length > 0 ? `Fix list from the last round:\n- ${i.fixList.join('\n- ')}` : '', 'Commit on the worktree branch, run the checks before you stop, and answer with the tip sha, the checks you ran, deferred criteria and your decision lines.'].filter(Boolean).join('\n\n'))
  .intents('read', 'edit', 'run');
export const reviewerRole = H.role('reviewer').input(z.object({ title: z.string(), criteria: z.array(z.string()), sha: z.string() })).output(verdict).prompt((i) => `Review the diff at ${i.sha} for "${i.title}" against CODING.md and the criteria:\n- ${i.criteria.join('\n- ')}\nList blocking findings with file and line.`).intents('read', 'run');
export const verifierRole = H.role('verifier').input(z.object({ title: z.string(), criteria: z.array(z.string()), sha: z.string() })).output(verdict).prompt((i) => `For ${i.sha} say per criterion whether it is met, from the diff and the tests:\n- ${i.criteria.join('\n- ')}`).intents('read', 'run');
export const judgeRole = H.role('judge').input(z.object({ title: z.string(), sha: z.string() })).output(verdict).prompt((i) => `Judge the screens of ${i.sha} for "${i.title}" against the approved boards and honesty on screen.`).intents('read', 'browse');
export const hotfixRole = H.role('hotfix').input(z.object({ title: z.string(), repro: z.string() })).output(z.object({ sha: z.string(), summary: z.string() })).prompt((i) => `Fix in a few lines: ${i.title}. Repro: ${i.repro}. Run the tests that cover the files you change and answer with the sha.`).intents('read', 'edit', 'run');

type Records = { readonly review: { readonly blocking: string[] }; readonly verify: { readonly blocking: string[] }; readonly judge: { readonly blocking: string[] } } | undefined;
const blockingOf = (records: Records): string[] => (records ? [...records.review.blocking, ...records.verify.blocking, ...records.judge.blocking] : []);

export function crookedHarness(options: CrookedHarnessOptions) {
  const quota = sqlite.quota('claude', { path: path.join(options.stateDir, 'quota.sqlite') });
  // The owner's three Max subscriptions, each signed in at its own Claude Code configuration directory.
  const max1 = claudeCode.subscription('max-1', { configDir: H.env('CLAUDE_CONFIG_DIR_1'), quota });
  const max2 = claudeCode.subscription('max-2', { configDir: H.env('CLAUDE_CONFIG_DIR_2'), quota });
  const max3 = claudeCode.subscription('max-3', { configDir: H.env('CLAUDE_CONFIG_DIR_3'), quota });
  const subs = H.pool('subs').accounts(max1, max2, max3);
  const opus = claudeCode.model('opus', { id: options.models?.opus ?? 'claude-opus-5-5' });
  const sonnet = claudeCode.model('sonnet', { id: options.models?.sonnet ?? 'claude-sonnet-5-5' });
  const builder = H.seat('builder').role(builderRole).model(opus).pool(subs);
  const reviewer = H.seat('reviewer').role(reviewerRole).model(opus).pool(subs);
  const verifier = H.seat('verifier').role(verifierRole).model(opus).pool(subs);
  const judge = H.seat('judge').role(judgeRole).model(sonnet).pool(subs);
  const hotfix = H.seat('hotfix').role(hotfixRole).model(sonnet).pool(subs);

  const runner = local.runner('local', { maxConcurrentSlots: 2 });
  // The product's own gate for a change: the tests of the packages it touches (running.md § CI and the queue).
  const checks = H.command('checks').argv(['pnpm', 'check:touched', '--direct']).runner(runner).effect('repeatable');
  const journeys = H.command('journeys').argv(['pnpm', 'journeys']).runner(runner).effect('repeatable');
  const merge = H.command('merge').input(z.object({ sha: z.string() })).argv((i) => ['pnpm', 'queue', i.sha]).runner(runner).effect('external', async ({ input, exec }) => (await exec(['git', 'merge-base', '--is-ancestor', input.sha, 'origin/main'])).exitCode === 0);
  const workspace = git.worktree('worktree', { repo: options.repo, root: path.join(options.stateDir, 'worktrees') }).withAreas(Areas, { app: ['apps/app/**'], api: ['apps/api/**'], admin: ['apps/admin/**'], infra: ['infra/**'] });

  const rounds = z.object({ blocking: z.array(z.string()), round: z.number(), sha: z.string() });
  const ticketFlow = H.flow('ticket')
    .input(ticket)
    .loop(
      'rounds',
      { carry: rounds, initial: { blocking: [], round: 0, sha: '' } },
      (round) =>
        round
          .step('build', builder, (ctx) => ({ title: ctx.unit.attributes.title, criteria: ctx.unit.attributes.criteria, sections: ctx.unit.attributes.sections, rulings: ctx.unit.attributes.rulings, fixList: ctx.steps.rounds.blocking }), { workspace, guard: { leases: Areas, beforeStop: checks } })
          .parallel('records', {
            review: { exec: reviewer, input: (ctx) => ({ title: ctx.unit.attributes.title, criteria: ctx.unit.attributes.criteria, sha: ctx.steps.build.sha }) },
            verify: { exec: verifier, input: (ctx) => ({ title: ctx.unit.attributes.title, criteria: ctx.unit.attributes.criteria, sha: ctx.steps.build.sha }) },
            judge: { exec: judge, input: (ctx) => ({ title: ctx.unit.attributes.title, sha: ctx.steps.build.sha }) },
          }),
      {
        max: 4,
        until: (ctx) => blockingOf(ctx.steps.records).length === 0,
        next: (ctx) => ({ blocking: blockingOf(ctx.steps.records), round: ctx.steps.rounds.round + 1, sha: ctx.steps.build.sha }),
      },
    )
    .halt('needs-you', needsYou, {
      ask: (ctx) => `${ctx.unit.attributes.id}: ${blockingOf(ctx.steps.records).length} blocking items after ${ctx.steps.rounds.round + 1} rounds; rule`,
      when: (ctx) => blockingOf(ctx.steps.records).length > 0,
    })
    .halt('sign-off', signOff, { ask: (ctx) => `sign off ${ctx.unit.attributes.id} at ${ctx.steps.build?.sha}?`, escalate: { afterMinutes: 240, run: H.command('nudge').argv(['pnpm', 'nudge', 'owner']).runner(runner) } })
    .exit('abandoned', (ctx) => !ctx.steps['sign-off'].merge)
    .step('merge', merge, (ctx) => ({ sha: ctx.steps.build?.sha ?? '' }))
    .exit('merged');

  const tickets = H.lane('tickets', Ticket)
    .supply(H.operator)
    .handler(ticketFlow, { exits: { merged: Merged, abandoned: Abandoned } })
    .retry({ tries: 1, backoff: 'fixed', initialDelayMs: 5 * 60_000, exhausted: { state: Blocked, reopenAfter: { hours: 12 } } })
    .on(H.cancel, { enter: Abandoned });

  const epicFlow = H.flow('epic')
    .input(epic)
    .spawn('tickets', tickets, (ctx) => ctx.unit.attributes.tickets.map((entry) => ({ ...entry, epic: ctx.unit.attributes.id })))
    .exit('cancelled', (ctx) => ctx.steps.tickets.some((child) => child.verdict === 'failure'))
    .exit('shipped');
  const epics = H.lane('epics', Epic).supply(H.operator).handler(epicFlow, { exits: { shipped: Shipped, cancelled: Cancelled } }).retry({ tries: 0, exhausted: Cancelled }).on(H.cancel, { enter: Cancelled });

  const bugFlow = H.flow('bug')
    .input(bugReport)
    .halt('bug-triage', triage, { ask: (ctx) => `fix ${ctx.unit.attributes.id} as a hotfix? ${ctx.unit.attributes.title}` })
    .exit('abandoned', (ctx) => !ctx.steps['bug-triage'].fix)
    .step('fix', hotfix, (ctx) => ({ title: ctx.unit.attributes.title, repro: ctx.unit.attributes.repro }), { workspace, guard: { leases: Areas, beforeStop: checks } })
    .step('merge', merge, (ctx) => ({ sha: ctx.steps.fix.sha }))
    .exit('merged');
  const bugs = H.lane('bugs', Bug).supply(H.operator).handler(bugFlow, { exits: { merged: Merged, abandoned: Abandoned } }).retry({ tries: 0, exhausted: Abandoned }).on(H.cancel, { enter: Abandoned });

  const heartbeatFlow = H.flow('heartbeat').input(heartbeat).step('journeys', journeys).exit('passed');
  const heartbeats = H.lane('heartbeats', Heartbeat).handler(heartbeatFlow, { exits: { passed: Passed } }).retry({ tries: 0, exhausted: FailedRun }).on(H.cancel, { enter: FailedRun });
  const nightly = H.trigger('nightly')
    .on(H.when.transition(heartbeats, { to: [Passed, FailedRun] }))
    .do((e, act) => act.create(heartbeats, { night: new Date(new Date(`${e.unit.attributes.night}T02:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10) }));
  const journeyFailed = H.trigger('journeys-failed')
    .on(H.when.transition(heartbeats, { to: [FailedRun] }))
    .do((e, act) => act.create(bugs, { id: `nightly-${e.unit.attributes.night}`, title: `nightly journeys failed on ${e.unit.attributes.night}`, repro: 'see the nightly run' }));

  const owner = claudeCode.supervisor('owner', {
    ...(options.supervisorPort !== undefined ? { port: options.supervisorPort } : {}),
    grants: [H.ops.work.create, H.ops.work.read, H.ops.work.update, H.ops.work.cancel, H.ops.attempts.recover, H.ops.lanes.pause, H.ops.telemetry.read, H.ops.accounts.read, H.ops.resolve(signOff, needsYou, triage)],
  });

  const harness = H.harness('crooked')
    .ledger(sqlite.ledger({ path: path.join(options.stateDir, 'ledger.sqlite') }))
    .lanes(epics, tickets, bugs, heartbeats)
    .triggers(nightly, journeyFailed)
    .scheduler(H.scheduler('s').expedite(bugs, { holds: [tickets] }).standard(epics, tickets, heartbeats).wip(tickets, 1).wip(bugs, 1))
    .clients(owner)
    .observers(markdown.board('board', { path: path.join(options.stateDir, 'BOARD.md') }), markdown.telemetry('telemetry', { path: path.join(options.stateDir, 'TELEMETRY.md') }));

  const drivers: readonly ModelDriver[] = [claudeCode.driver({ workDir: options.repo, sessionDir: path.join(options.stateDir, 'sessions') })];
  return { harness, drivers, owner, lanes: { epics, tickets, bugs, heartbeats }, halts: { signOff, needsYou, triage }, workspace, quota };
}
