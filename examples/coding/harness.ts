import path from 'node:path';
import { z } from 'zod';
import { claudeCode } from '../../src/adapters/claude-code/index.js';
import { git } from '../../src/adapters/git/index.js';
import { http } from '../../src/adapters/http/index.js';
import { local } from '../../src/adapters/local/index.js';
import { markdown } from '../../src/adapters/markdown/index.js';
import { sqlite } from '../../src/adapters/sqlite/index.js';
import { H } from '../../src/dsl/index.js';
import type { ModelDriver } from '../../src/kernel/index.js';

/**
 * A coding loop on a small repository: a builder agent fixes a bug in a git worktree under guards
 * (area leases on write, the test run before it may stop), the checks run again as a command, a
 * human approves through the HTTP control API, and the fix lands as the unit's terminal state.
 */
export interface CodingHarnessOptions {
  /** The repository the builder works on; one worktree per attempt. */
  readonly repo: string;
  /** Where the ledger, the quota partition, the worktrees, the board and the sessions live. */
  readonly stateDir: string;
  readonly model?: string;
  /** The env variable holding the HTTP control API's bearer token. */
  readonly opsToken?: string;
}

export const Open = H.state('Open', 'pending');
export const Fixed = H.terminal('Fixed', 'success');
export const Rejected = H.terminal('Rejected', 'failure');
export const Failed = H.terminal('Failed', 'failure');

export const bug = z.object({ id: z.string(), title: z.string(), hint: z.string() });
export const Bug = H.kind('Bug').attributes(bug).states(Open, Fixed, Rejected, Failed).key((a) => a.id).initial(Open);
export const Areas = H.resources('area', ['src', 'test']);
export const approval = H.halt('approval').decision(z.object({ approved: z.boolean(), note: z.string().optional() }));

export const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), hint: z.string() }))
  .output(z.object({ summary: z.string(), changed: z.array(z.string()) }))
  .prompt(
    (i) =>
      [
        `You are working in a git worktree of a small TypeScript project. Bug: ${i.title}. ${i.hint}`,
        'Edit files under src/ only; never touch the tests.',
        'Run `node --experimental-strip-types --test test/sum.test.ts` until it passes.',
        'Then answer with a one-sentence summary and the list of files you changed.',
      ].join('\n'),
  )
  .intents('read', 'edit', 'run');

export function codingHarness(options: CodingHarnessOptions) {
  const quota = sqlite.quota('claude', { path: path.join(options.stateDir, 'quota.sqlite') });
  const account = claudeCode.subscription('max', { quota });
  const model = claudeCode.model('builder-model', { id: options.model ?? 'claude-haiku-5-5' });
  const subs = H.pool('subs').accounts(account);
  const builder = H.seat('builder').role(builderRole).model(model).pool(subs);
  const runner = local.runner('local', { maxConcurrentSlots: 1 });
  const checks = H.command('checks').argv(['node', '--experimental-strip-types', '--test', 'test/sum.test.ts']).runner(runner).effect('repeatable');
  const workspace = git.worktree('worktree', { repo: options.repo, root: path.join(options.stateDir, 'worktrees') }).withAreas(Areas, { src: ['src/**'], test: ['test/**'] });

  const fix = H.flow('fix')
    .input(bug)
    .step('build', builder, (ctx) => ({ title: ctx.unit.attributes.title, hint: ctx.unit.attributes.hint }), { workspace, guard: { leases: Areas, beforeStop: checks } })
    .step('checks', checks)
    .halt('approval', approval, { ask: (ctx) => `merge the fix for ${ctx.unit.attributes.id}: ${ctx.steps.build.summary}`, timeout: { afterMinutes: 240, decide: () => ({ approved: false, note: 'no answer in four hours' }) } })
    .exit('rejected', (ctx) => !ctx.steps.approval.approved)
    .exit('fixed');

  const fixes = H.lane('fixes', Bug)
    .supply(H.operator)
    .handler(fix, { exits: { fixed: Fixed, rejected: Rejected } })
    .retry({ tries: 0, exhausted: Failed })
    .on(H.cancel, { enter: Rejected });

  const ops = http.controlApi('ops', {
    port: 0,
    token: H.env(options.opsToken ?? 'HARNESS_OPS_TOKEN'),
    grants: [H.ops.work.create, H.ops.work.read, H.ops.resolve(approval), H.ops.attempts.recover, H.ops.telemetry.read, H.ops.accounts.read],
  });

  const harness = H.harness('coding')
    .ledger(sqlite.ledger({ path: path.join(options.stateDir, 'ledger.sqlite') }))
    .lanes(fixes)
    .scheduler(H.scheduler('s').standard(fixes).wip(fixes, 1))
    .clients(ops)
    .observers(markdown.board('board', { path: path.join(options.stateDir, 'BOARD.md') }), markdown.telemetry('telemetry', { path: path.join(options.stateDir, 'TELEMETRY.md') }));

  const drivers: readonly ModelDriver[] = [claudeCode.driver({ workDir: options.repo, sessionDir: path.join(options.stateDir, 'sessions') })];
  return { harness, drivers, ops, fixes, approval, quota, workspace };
}
