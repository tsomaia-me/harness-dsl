import { z } from 'zod';
import { H } from '../../../src/dsl/index.js';
import { fakeAccount, fakeClient, fakeLedger, fakeMemoryStore, fakeModel, fakeObserver, fakeQuota, fakeRunner, fakeStore, fakeSupplier, fakeWorkspace } from './doubles.js';

const workItem = z.object({ ref: z.string(), title: z.string(), description: z.string() });
const heartbeatItem = z.object({ service: z.string(), at: z.string() });

const Todo = H.state('Todo', 'pending');
const Done = H.terminal('Done', 'success');
const Abandoned = H.terminal('Abandoned', 'failure');
const EpicOpen = H.state('EpicOpen', 'pending');
const EpicDelivered = H.terminal('EpicDelivered', 'success');
const EpicPartial = H.terminal('EpicPartial', 'failure');
const BeatDue = H.state('BeatDue', 'pending');
const Healthy = H.terminal('Healthy', 'success');
const Unhealthy = H.terminal('Unhealthy', 'failure');

const Bug = H.kind('Bug').attributes(workItem).states(Todo, Done, Abandoned).key((a) => a.ref).initial(Todo);
const Feature = H.kind('Feature').attributes(workItem).states(Todo, Done, Abandoned).key((a) => a.ref).initial(Todo);
const Epic = H.kind('Epic').attributes(workItem).states(EpicOpen, EpicDelivered, EpicPartial).key((a) => a.ref).initial(EpicOpen);
const ServiceHeartbeat = H.kind('ServiceHeartbeat').attributes(heartbeatItem).states(BeatDue, Healthy, Unhealthy).key((a) => `${a.service}@${a.at}`).initial(BeatDue);

const Areas = H.resources('areas', ['edge', 'admin', 'shared']);

const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), description: z.string(), deficits: z.array(z.string()) }))
  .output(z.object({ summary: z.string(), filesChanged: z.array(z.string()) }))
  .prompt((i) => `Implement: ${i.title}\n\n${i.description}${i.deficits.length > 0 ? `\n\nFix these deficits from the last audit:\n- ${i.deficits.join('\n- ')}` : ''}`)
  .intents('read', 'edit', 'run', 'search', 'halt');
const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), description: z.string(), summary: z.string(), filesChanged: z.array(z.string()) }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt((i) => `Audit the change for: ${i.title}\n\n${i.description}\n\nBuilder summary: ${i.summary}\nFiles: ${i.filesChanged.join(', ')}`)
  .intents('read', 'run', 'search', 'record');
const plannerRole = H.role('planner')
  .input(workItem)
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }))
  .prompt((i) => `Decompose this epic into independently shippable features.\n\n${i.title}\n\n${i.description}`)
  .intents('read', 'search');

const claudeQuota = fakeQuota('claude-accounts');
const subscriptionA = fakeAccount('claude-max-a', 'claude-code', claudeQuota);
const subscriptionB = fakeAccount('claude-max-b', 'claude-code', claudeQuota);
const subscriptionC = fakeAccount('claude-max-c', 'claude-code', claudeQuota);
const apiAccount = fakeAccount('claude-api', 'claude-code', claudeQuota);

const soonestExpiring = H.policy.account('soonest-expiring', (ctx) =>
  ctx.candidates
    .filter((a) => a.shareUsed < a.shareCap && (a.cooldownUntil === undefined || a.cooldownUntil <= ctx.now))
    .sort((a, b) => (a.windowResetsAt?.getTime() ?? Number.POSITIVE_INFINITY) - (b.windowResetsAt?.getTime() ?? Number.POSITIVE_INFINITY))[0],
);

const claudePool = H.pool('claude-subscriptions').accounts(subscriptionA, subscriptionB, subscriptionC).drain(soonestExpiring).fallback(apiAccount);

const sonnet = fakeModel('sonnet', 'claude-code', 'claude-sonnet-5-5');
const opus = fakeModel('opus', 'claude-code', 'claude-opus-5-5');

const builderModel = H.policy.model('builder-model', [sonnet, opus], (ctx) => {
  const cheaper = ctx.metrics.attempts({ of: ctx.kind, seat: ctx.seat, model: sonnet, window: { lastDays: 14 } });
  return cheaper.samples >= 20 && cheaper.successRate < 0.85 ? opus : sonnet;
});

const builder = H.seat('builder').role(builderRole).model(builderModel).pool(claudePool);
const auditor = H.seat('auditor').role(auditorRole).model(sonnet).pool(claudePool);
const planner = H.seat('planner').role(plannerRole).model(opus).pool(claudePool);

const ownerDecision = H.halt('owner-decision').decision(z.object({ choice: z.string(), note: z.string().optional() }));

const localRunner = fakeRunner('local').slots(4);
const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(localRunner);
const worktree = fakeWorkspace('worktree').withAreas(Areas, { edge: ['apps/edge/**'], admin: ['apps/admin/**'], shared: ['packages/**'] });

const buildAudit = H.flow('build-audit')
  .input(workItem)
  .params(z.object({ rounds: z.number() }))
  .loop(
    'rounds',
    { carry: z.object({ deficits: z.array(z.string()) }), initial: { deficits: [] } },
    (round) =>
      round
        .step(
          'build',
          builder,
          (ctx) => ({ title: ctx.unit.attributes.title, description: ctx.unit.attributes.description, deficits: ctx.steps.rounds.deficits }),
          { workspace: worktree, guard: { leases: Areas, beforeStop: projectChecks }, halts: [ownerDecision] },
        )
        .step(
          'audit',
          auditor,
          (ctx) => ({ title: ctx.unit.attributes.title, description: ctx.unit.attributes.description, summary: ctx.steps.build.summary, filesChanged: ctx.steps.build.filesChanged }),
          { workspace: worktree },
        ),
    {
      max: (ctx) => ctx.params.rounds,
      until: (ctx) => ctx.steps.audit.deficits.length === 0,
      next: (ctx) => ({ deficits: ctx.steps.audit.deficits }),
    },
  )
  .exit('done', (ctx) => ctx.steps.audit.deficits.length === 0)
  .exit('incomplete');

const tracker = fakeStore('linear', ['Todo', 'In Progress', 'Blocked', 'Done', 'Canceled'] as const);
const issues = fakeSupplier<{ identifier: string; title: string; description: string }>('linear-issues');
const bugFiles = fakeSupplier<{ path: string; name: string; body: string }>('bug-files');

const bugLane = H.lane('bugs', Bug)
  .supply(issues, (issue, to) => to.create({ ref: issue.identifier, title: issue.title, description: issue.description }))
  .supply(bugFiles, (file, to) => to.create({ ref: file.path, title: file.name, description: file.body }))
  .supply(H.operator)
  .handler(buildAudit, { exits: { done: Done, incomplete: Abandoned }, params: { rounds: 3 } })
  .store(tracker, { states: { Todo: 'Todo', Done: 'Done', Abandoned: 'Canceled' } })
  .retry({ tries: 2, backoff: 'exponential', initialDelayMs: 60_000, exhausted: Abandoned })
  .on(H.cancel, { enter: Abandoned });

const featureLane = H.lane('features', Feature)
  .supply(issues, (issue, to) => to.create({ ref: issue.identifier, title: issue.title, description: issue.description }))
  .supply(H.operator)
  .handler(buildAudit, { exits: { done: Done, incomplete: Abandoned }, params: { rounds: 5 } })
  .store(tracker, { states: { Todo: 'Todo', Done: 'Done', Abandoned: 'Canceled' } })
  .retry({ tries: 2, backoff: 'exponential', initialDelayMs: 60_000, exhausted: Abandoned })
  .on(H.cancel, { enter: Abandoned });

const epicFlow = H.flow('epic-decompose')
  .input(workItem)
  .step('plan', planner, (ctx) => ctx.unit.attributes)
  .spawn('features', featureLane, (ctx) => ctx.steps.plan.features.map((feature, index) => ({ ref: `${ctx.unit.attributes.ref}-${index + 1}`, title: feature.title, description: feature.description })))
  .exit('complete', (ctx) => ctx.steps.features.every((child) => child.verdict === 'success'))
  .exit('incomplete');

const epicLane = H.lane('epics', Epic)
  .supply(issues, (issue, to) => to.create({ ref: issue.identifier, title: issue.title, description: issue.description }))
  .handler(epicFlow, { exits: { complete: EpicDelivered, incomplete: EpicPartial } })
  .store(fakeStore('epics', []))
  .retry({ tries: 2, backoff: 'fixed', initialDelayMs: 300_000, exhausted: EpicPartial })
  .on(H.cancel, { enter: EpicPartial });

const heartbeatProbe = H.command('service-heartbeat').input(heartbeatItem).argv((i) => ['./scripts/heartbeat.sh', i.service]).runner(localRunner).acceptExitCodes(0, 1);

const heartbeatFlow = H.flow('heartbeat')
  .input(heartbeatItem)
  .step('probe', heartbeatProbe, (ctx) => ctx.unit.attributes)
  .exit('healthy', (ctx) => ctx.steps.probe.exitCode === 0)
  .exit('unhealthy');

const ticks = fakeSupplier<{ at: Date }>('every-five-minutes');
const heartbeatLane = H.lane('heartbeats', ServiceHeartbeat)
  .supply(ticks, (tick, to) => to.create({ service: 'api', at: tick.at.toISOString() }))
  .handler(heartbeatFlow, { exits: { healthy: Healthy, unhealthy: Unhealthy } })
  .retry({ tries: 0, exhausted: Unhealthy })
  .on(H.cancel, { enter: Unhealthy });

const heartbeatFilesBug = H.trigger('heartbeat-files-bug')
  .on(H.when.transition(heartbeatLane, { to: Unhealthy }))
  .do((event, act) =>
    act.create(bugLane, {
      ref: `heartbeat-${event.unit.attributes.service}`,
      title: `Service ${event.unit.attributes.service} heartbeat failed`,
      description: `The heartbeat at ${event.unit.attributes.at} failed. Diagnose the service and fix the cause.`,
    }),
  );

const experience = H.memory('engineering-experience', 'experience');
const taste = H.memory('owner-taste', 'taste');
const experienceJournal = H.journal('experience', experience).store(fakeMemoryStore('experience.jsonl')).readBy(builderRole, auditorRole).recordedBy(auditorRole);
const tasteJournal = H.journal('taste', taste).store(fakeMemoryStore('taste.jsonl')).readBy(builderRole, plannerRole);

const schedule = H.scheduler('coding-team').standard(heartbeatLane, bugLane, featureLane, epicLane).wip(bugLane, 2).wip(epicLane, 1).aging(featureLane, { afterMinutes: 240 });

const productionProbe = H.operation('production-health-probe', H.command('production-probe').argv(['./scripts/production-probe.sh']).runner(localRunner));

const supervisor = fakeClient('supervisor', [
  H.ops.work.read,
  H.ops.work.create,
  H.ops.work.update,
  H.ops.work.cancel,
  H.ops.resolve(ownerDecision),
  H.ops.attempts.recover,
  H.ops.memory.read,
  H.ops.memory.write,
  H.ops.telemetry.read,
  H.ops.accounts.read,
  H.ops.accounts.share,
  productionProbe,
]);

export const codingTeam = H.harness('coding-team')
  .ledger(fakeLedger())
  .lanes(heartbeatLane, bugLane, featureLane, epicLane)
  .journals(experienceJournal, tasteJournal)
  .triggers(heartbeatFilesBug)
  .scheduler(schedule)
  .clients(supervisor)
  .observers(fakeObserver('board'), fakeObserver('telemetry'))
  .share(subscriptionA, 0.6)
  .share(subscriptionB, 0.6)
  .share(subscriptionC, 0.3);

export const lanes = { heartbeatLane, bugLane, featureLane, epicLane };
export const flows = { buildAudit, epicFlow, heartbeatFlow };
