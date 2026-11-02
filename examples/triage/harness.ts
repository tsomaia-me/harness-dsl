import path from 'node:path';
import { z } from 'zod';
import { anthropic } from '../../src/adapters/anthropic/index.js';
import { google } from '../../src/adapters/google/index.js';
import { http } from '../../src/adapters/http/index.js';
import { markdown } from '../../src/adapters/markdown/index.js';
import { sqlite } from '../../src/adapters/sqlite/index.js';
import { H } from '../../src/dsl/index.js';
import type { ModelDriver } from '../../src/kernel/index.js';

/**
 * Support triage, nothing to do with code: a classifier seat on the Anthropic API reads each
 * conversation, a policy sends low-urgency replies on its own and asks a human for the rest, a
 * metric over the decisions pauses the lane when approvals drop, and the board shows it all.
 */
export interface TriageHarnessOptions {
  readonly stateDir: string;
  /** The API the classifier runs on; the Anthropic API unless told otherwise. */
  readonly provider?: 'anthropic' | 'google';
  readonly model?: string;
  readonly opsToken?: string;
}

const DEFAULT_MODEL = { anthropic: 'claude-haiku-5-5', google: 'gemini-3.5-flash-lite' } as const;

export const New = H.state('New', 'pending');
export const Answered = H.terminal('Answered', 'success');
export const Escalated = H.terminal('Escalated', 'neutral');
export const Dropped = H.terminal('Dropped', 'failure');

export const conversation = z.object({ id: z.string(), from: z.string(), text: z.string() });
export const Conversation = H.kind('Conversation').attributes(conversation).states(New, Answered, Escalated, Dropped).key((a) => a.id).initial(New);
export const Category = H.facet('category', ['billing', 'refund', 'other']);
export const send = H.halt('send').decision(z.object({ send: z.boolean(), edited: z.string().optional() }));

export const classifierRole = H.role('classifier')
  .input(z.object({ from: z.string(), text: z.string() }))
  .output(z.object({ category: z.enum(['billing', 'refund', 'other']), urgency: z.enum(['low', 'high']), reply: z.string() }))
  .prompt((i) => [`A customer wrote (from ${i.from}):`, i.text, '', 'Classify the category (billing, refund, other) and the urgency (high when money is at stake or the customer is angry, else low), and draft a short, polite reply.'].join('\n'))
  .intents();

export function triageHarness(options: TriageHarnessOptions) {
  const provider = options.provider ?? 'anthropic';
  const quota = sqlite.quota(provider, { path: path.join(options.stateDir, 'quota.sqlite') });
  const modelId = options.model ?? DEFAULT_MODEL[provider];
  const api = provider === 'google' ? google.account('api', { apiKey: H.env('GEMINI_API_KEY'), quota }) : anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
  const model = provider === 'google' ? google.model('classifier-model', { id: modelId }) : anthropic.model('classifier-model', { id: modelId });
  const classifier = H.seat('classifier').role(classifierRole).model(model).pool(H.pool('api').accounts(api));

  const Urgency = H.facet('urgency', ['low', 'high']);
  const autoSend = H.policy.halt('auto-send', Conversation, send).decide((ctx) => (ctx.facets.some((facet) => facet.facet.name === 'urgency' && facet.value === 'low') ? { send: true } : undefined));

  const triage = H.flow('triage')
    .input(conversation)
    .step('classify', classifier, (ctx) => ({ from: ctx.unit.attributes.from, text: ctx.unit.attributes.text }))
    .halt('send', send, {
      ask: (ctx) => `send to ${ctx.unit.attributes.from}? "${ctx.steps.classify.reply}"`,
      facets: (ctx) => [Category.of(ctx.steps.classify.category), Urgency.of(ctx.steps.classify.urgency)],
      skip: autoSend,
    })
    .exit('escalated', (ctx) => !ctx.steps.send.send)
    .exit('answered');

  const conversations = H.lane('conversations', Conversation)
    .supply(H.operator)
    .handler(triage, { exits: { answered: Answered, escalated: Escalated } })
    .retry({ tries: 1, exhausted: Dropped })
    .on(H.cancel, { enter: Dropped });

  const approvals = H.metric('approvals', H.when.decision(Conversation, send)).samples((e) => [{ hit: e.decision.send, facets: e.facets }]);
  const lowApproval = H.trigger('low-approval')
    .on(H.when.crossing(approvals, { window: { lastDays: 1 }, minSamples: 4, enter: { below: 0.5 }, exit: { above: 0.75 }, per: Category }, 'entered'))
    .do((e, act) => act.pause(conversations, `approvals for ${e.group.value} fell to ${e.rate.toFixed(2)}`));
  const recovered = H.trigger('approval-recovered')
    .on(H.when.crossing(approvals, { window: { lastDays: 1 }, minSamples: 4, enter: { below: 0.5 }, exit: { above: 0.75 }, per: Category }, 'exited'))
    .do((e, act) => act.resume(conversations, `approvals for ${e.group.value} back at ${e.rate.toFixed(2)}`));

  const ops = http.controlApi('ops', {
    port: 0,
    token: H.env(options.opsToken ?? 'HARNESS_OPS_TOKEN'),
    grants: [H.ops.work.create, H.ops.work.read, H.ops.resolve(send), H.ops.lanes.pause, H.ops.telemetry.read],
  });

  const harness = H.harness('triage')
    .ledger(sqlite.ledger({ path: path.join(options.stateDir, 'ledger.sqlite') }))
    .lanes(conversations)
    .metrics(approvals)
    .triggers(lowApproval, recovered)
    .scheduler(H.scheduler('s').standard(conversations).wip(conversations, 2))
    .clients(ops)
    .observers(markdown.board('board', { path: path.join(options.stateDir, 'BOARD.md') }), markdown.telemetry('telemetry', { path: path.join(options.stateDir, 'TELEMETRY.md') }));

  const drivers: readonly ModelDriver[] = [provider === 'google' ? google.driver() : anthropic.driver()];
  return { harness, drivers, ops, conversations, send, Category };
}
