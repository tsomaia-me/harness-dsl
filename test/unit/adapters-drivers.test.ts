import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { anthropic } from '../../src/adapters/anthropic/index.js';
import { claudeCode } from '../../src/adapters/claude-code/index.js';
import { credentialKey, credentialRef } from '../../src/adapters/model-calls.js';
import { H } from '../../src/dsl/index.js';
import { AccountRefusedError } from '../../src/kernel/index.js';
import type { MemoryItem, ModelRequest, Resolver } from '../../src/kernel/index.js';
import { fakeQuota } from './scenarios/doubles.js';

const resolver: Resolver = { env: (ref) => `secret-${ref.name}${ref.index === undefined ? '' : `#${ref.index}`}`, port: () => 0 };
const quota = fakeQuota('q');
const lesson: MemoryItem = {
  id: 'mem-1',
  memoryKind: 'experience',
  journal: 'lessons',
  createdAt: new Date('2026-11-01T00:00:00Z'),
  status: 'active',
  when: { kinds: [], roles: [], resources: [], facets: [] },
  text: 'run the checks before you stop',
  trackRecord: { used: 3, succeeded: 3 },
};
const outputSchema = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'], additionalProperties: false };

function request(account: ModelRequest['account'], modelId: string, extra: Partial<ModelRequest> = {}): ModelRequest {
  return {
    seat: 'reviewer',
    model: modelId,
    account,
    role: { name: 'reviewer', intents: ['read', 'run', 'record'], prompt: 'review abc' },
    input: { sha: 'abc' },
    memory: [lesson],
    halts: [{ name: 'approval', decisionSchema: { type: 'object' } }],
    outputSchema,
    idempotencyKey: 'u1/review',
    ...extra,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('the claude-code adapter', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'harness-claude-code-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const account = claudeCode.subscription('max-a', { token: H.env('MAX_A_TOKEN'), quota });
  const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-5-5' });

  function bridge(lines: readonly Record<string, unknown>[], exit = { exitCode: 0, stderr: '' }) {
    const calls: { args: string[]; env: Record<string, string>; cwd: string }[] = [];
    const spawnBridge = async (args: readonly string[], env: Record<string, string>, cwd: string, onLine: (line: string) => void) => {
      calls.push({ args: [...args], env, cwd });
      for (const line of lines) onLine(JSON.stringify(line));
      return exit;
    };
    return { calls, spawnBridge };
  }

  function flag(args: readonly string[], name: string): string | undefined {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args[at + 1];
  }

  it('declares the account and model under the claude-code driver', () => {
    expect.soft(account).toMatchObject({ entity: 'account', driver: 'claude-code', credential: { ref: 'env', name: 'MAX_A_TOKEN' }, quota });
    expect(sonnet).toMatchObject({ entity: 'model', driver: 'claude-code', id: 'claude-sonnet-5-5', batch: false });
  });

  it('runs claude -p with a session derived from the step, the role\'s tools, memory and halts in the prompt, and an envelope schema', async () => {
    const { calls, spawnBridge } = bridge([
      { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: 1793455200 } } } },
      { type: 'assistant', message: { usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'done' }] } },
      { type: 'result', total_cost_usd: 0.02, structured_output: { result: { verdict: 'ship' }, recorded: [{ journal: 'lessons', text: 'tests first' }] } },
    ]);
    const driver = claudeCode.driver({ spawnBridge, workDir: dir, sessionDir: path.join(dir, 'sessions'), inactivityTimeoutMs: 1_000 });
    expect.soft(driver).toMatchObject({ driver: 'claude-code', hooks: true });
    expect.soft(driver.serves(account)).toBe(true);

    const response = await driver.invoke(request(account, sonnet.id), resolver);
    const [call] = calls;
    expect.soft(flag(call!.args, '--model')).toBe('claude-sonnet-5-5');
    expect.soft(flag(call!.args, '--session-id')).toMatch(UUID);
    expect.soft(flag(call!.args, '--allowedTools')).toBe('Read,Glob,Grep,Bash');
    expect.soft(call!.args[call!.args.length - 1]).toBe('review abc');
    expect.soft(call!.cwd).toBe(dir);
    expect.soft(call!.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('secret-MAX_A_TOKEN');
    const system = flag(call!.args, '--append-system-prompt') ?? '';
    expect.soft(system).toContain('run the checks before you stop');
    expect.soft(system).toContain('approval');
    const schema = JSON.parse(flag(call!.args, '--json-schema') ?? '{}') as { properties: Record<string, any>; required: string[] };
    expect.soft(schema.properties.result.anyOf[0]).toEqual(outputSchema);
    expect.soft(schema.required).toEqual(['result', 'halt', 'recorded']);
    expect.soft(schema.properties.halt.anyOf[0].properties.name.enum).toEqual(['approval']);
    expect.soft(schema.properties.recorded.anyOf[0].type).toBe('array');
    expect.soft(response).toMatchObject({ output: { verdict: 'ship' }, costUsd: 0, tokens: 15, sessionId: flag(call!.args, '--session-id') });
    expect.soft(response.recorded).toEqual([{ journal: 'lessons', text: 'tests first', when: { kinds: [], roles: [], resources: [], facets: [] } }]);
    expect.soft(response.windows).toEqual([{ window: 'anthropic:5h', kind: 'allowance', utilization: 0.42, resetsAt: new Date(1793455200_000) }]);

    const again = await driver.invoke(request(account, sonnet.id), resolver);
    expect.soft(again.sessionId).toBe(response.sessionId);
    const other = await driver.invoke(request(account, sonnet.id, { idempotencyKey: 'u2/review' }), resolver);
    expect(other.sessionId).not.toBe(response.sessionId);
  });

  it('finds a finished invocation by its key after a crash and reports the rest as lost', async () => {
    const { spawnBridge } = bridge([{ type: 'result', structured_output: { result: { verdict: 'ship' } } }]);
    const driver = claudeCode.driver({ spawnBridge, workDir: dir, sessionDir: path.join(dir, 'sessions') });
    await driver.invoke(request(account, sonnet.id), resolver);
    const fresh = claudeCode.driver({ spawnBridge, workDir: dir, sessionDir: path.join(dir, 'sessions') });
    expect.soft(await fresh.session('u1/review', resolver)).toMatchObject({ status: 'finished', response: { output: { verdict: 'ship' } } });
    expect(await fresh.session('u9/review', resolver)).toEqual({ status: 'lost' });
  });

  it('signs a subscription in at its configuration directory, one driver per sign-in, never through an inherited API key', async () => {
    const { calls, spawnBridge } = bridge([{ type: 'result', structured_output: { result: { verdict: 'ship' } } }]);
    const driver = claudeCode.driver({ spawnBridge, workDir: dir, sessionDir: path.join(dir, 'sessions') });
    const byDir = claudeCode.subscription('max-b', { configDir: H.env('CLAUDE_CONFIG_DIR_2'), quota });
    const byDefault = claudeCode.subscription('max-c', { quota });
    await driver.invoke(request(byDir, sonnet.id), resolver);
    await driver.invoke(request(account, sonnet.id, { idempotencyKey: 'u2/review' }), resolver);
    await driver.invoke(request(byDefault, sonnet.id, { idempotencyKey: 'u3/review' }), resolver);
    expect.soft(calls.map((call) => call.env.CLAUDE_CONFIG_DIR)).toEqual(['secret-CLAUDE_CONFIG_DIR_2', undefined, undefined]);
    expect.soft(calls.map((call) => call.env.CLAUDE_CODE_OAUTH_TOKEN)).toEqual([undefined, 'secret-MAX_A_TOKEN', undefined]);
    expect(driver['inners'].size).toBe(3);
  });

  it('returns a raised halt and resumes the session with the decision', async () => {
    const { calls, spawnBridge } = bridge([{ type: 'result', structured_output: { halt: { name: 'approval', ask: 'ship it?' } } }]);
    const driver = claudeCode.driver({ spawnBridge, workDir: dir, sessionDir: path.join(dir, 'sessions') });
    const halted = await driver.invoke(request(account, sonnet.id), resolver);
    expect.soft(halted.halt).toEqual({ halt: 'approval', ask: 'ship it?' });
    expect.soft(halted.output).toBeNull();

    const { calls: resumeCalls, spawnBridge: resumeBridge } = bridge([{ type: 'result', structured_output: { result: { verdict: 'ship' } } }]);
    const response = await claudeCode
      .driver({ spawnBridge: resumeBridge, workDir: dir, sessionDir: path.join(dir, 'sessions') })
      .invoke(request(account, sonnet.id, { resume: { sessionId: halted.sessionId!, halt: 'approval', decision: { approved: true } } }), resolver);
    expect.soft(flag(resumeCalls[0]!.args, '--resume')).toBe(halted.sessionId);
    expect.soft(resumeCalls[0]!.args).not.toContain('--append-system-prompt');
    expect.soft(resumeCalls[0]!.args[resumeCalls[0]!.args.length - 1]).toContain('{"approved":true}');
    expect.soft(response.output).toEqual({ verdict: 'ship' });
    expect(calls).toHaveLength(1);
  });

  it.each([
    { label: 'a rate limit with its reset', stderr: 'Error 429: Rate limit reached, resets in 5 minutes', refusal: 'rateLimited', untilMs: 5 * 60_000 },
    { label: 'an expired login', stderr: 'Error: not logged in, please run /login', refusal: 'unavailable', untilMs: 15 * 60_000 },
    { label: 'an account that cannot pay', stderr: 'Credit balance is too low', refusal: 'unavailable', untilMs: 15 * 60_000 },
  ])('turns $label into an account refusal with a cooldown', async ({ stderr, refusal, untilMs }) => {
    const { spawnBridge } = bridge([], { exitCode: 1, stderr });
    const driver = claudeCode.driver({ spawnBridge, workDir: dir, sessionDir: path.join(dir, 'sessions') });
    const before = Date.now();
    const error = await driver.invoke(request(account, sonnet.id), resolver).catch((err: unknown) => err);
    expect.soft(error).toBeInstanceOf(AccountRefusedError);
    const refused = error as AccountRefusedError;
    expect.soft(refused.account).toBe('max-a');
    expect.soft(refused.refusal).toBe(refusal);
    expect.soft(refused.until.getTime()).toBeGreaterThanOrEqual(before + untilMs - 1_000);
    expect(refused.until.getTime()).toBeLessThanOrEqual(Date.now() + untilMs + 1_000);
  });
});

describe('the anthropic adapter', () => {
  const account = anthropic.account('api', { apiKey: H.env('ANTHROPIC_KEY'), quota });
  const opus = anthropic.model('opus', { id: 'claude-opus-5-5' });

  function messagesFetch(text: string, headers: Record<string, string> = {}, status = 200) {
    const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (status !== 200) return new Response(JSON.stringify({ error: { message: text } }), { status, headers: { 'content-type': 'application/json', ...headers } });
      return new Response(
        JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1_000, output_tokens: 200 } }),
        { status: 200, headers: { 'content-type': 'application/json', ...headers } },
      );
    }) as typeof fetch;
    return { calls, fetchFn };
  }

  it('declares the account and a batch-capable model under the anthropic driver', () => {
    expect.soft(account).toMatchObject({ entity: 'account', driver: 'anthropic', credential: { ref: 'env', name: 'ANTHROPIC_KEY' }, quota });
    expect(opus).toMatchObject({ entity: 'model', driver: 'anthropic', id: 'claude-opus-5-5', batch: true });
  });

  it('calls the Messages API with the account\'s key, prices the usage, and reads the unified windows', async () => {
    const { calls, fetchFn } = messagesFetch(JSON.stringify({ result: { verdict: 'ship' } }), {
      'anthropic-ratelimit-unified-5h-utilization': '0.42',
      'anthropic-ratelimit-unified-5h-reset': '1793455200',
    });
    const driver = anthropic.driver({ fetch: fetchFn });
    expect.soft(driver).toMatchObject({ driver: 'anthropic', hooks: false });
    const response = await driver.invoke(request(account, opus.id), resolver);
    expect.soft(calls[0]?.headers['x-api-key']).toBe('secret-ANTHROPIC_KEY');
    expect.soft(calls[0]?.body.model).toBe('claude-opus-5-5');
    expect.soft(calls[0]?.body.output_config.format.schema.properties.result.anyOf[0]).toMatchObject({ properties: { verdict: { type: 'string' } } });
    expect.soft(calls[0]?.body.system[0].text).toContain('run the checks before you stop');
    expect.soft(response.output).toEqual({ verdict: 'ship' });
    expect.soft(response.tokens).toBe(1_200);
    expect.soft(response.costUsd).toBeGreaterThan(0);
    expect(response.windows).toEqual([{ window: 'anthropic:5h', kind: 'allowance', utilization: 0.42, resetsAt: new Date(1793455200_000) }]);
  });

  it('turns a 429 into an account refusal that carries the retry-after cooldown', async () => {
    const { fetchFn } = messagesFetch('Rate limit reached', { 'retry-after': '120' }, 429);
    const driver = anthropic.driver({ fetch: fetchFn });
    const before = Date.now();
    const error = await driver.invoke(request(account, opus.id), resolver).catch((err: unknown) => err);
    expect.soft(error).toBeInstanceOf(AccountRefusedError);
    expect.soft((error as AccountRefusedError).refusal).toBe('rateLimited');
    expect((error as AccountRefusedError).until.getTime()).toBeGreaterThanOrEqual(before + 120_000 - 1_000);
  });

  it('turns an account that cannot pay into an unavailable refusal, not a failed step', async () => {
    const { fetchFn } = messagesFetch('Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.', {}, 400);
    const driver = anthropic.driver({ fetch: fetchFn });
    const error = await driver.invoke(request(account, opus.id), resolver).catch((err: unknown) => err);
    expect.soft(error).toBeInstanceOf(AccountRefusedError);
    expect((error as AccountRefusedError).refusal).toBe('unavailable');
  });

  it('two accounts on one variable\'s values use their own keys, and a batch job id keeps the value\'s index', async () => {
    const { calls, fetchFn } = messagesFetch(JSON.stringify({ result: { verdict: 'ship' } }));
    const driver = anthropic.driver({ fetch: fetchFn });
    const first = anthropic.account('api-1', { apiKey: H.env('ANTHROPIC_KEY', { index: 0 }), quota });
    const second = anthropic.account('api-2', { apiKey: H.env('ANTHROPIC_KEY', { index: 1 }), quota });
    await driver.invoke(request(first, opus.id), resolver);
    await driver.invoke(request(second, opus.id), resolver);
    expect.soft(calls.map((call) => call.headers['x-api-key'])).toEqual(['secret-ANTHROPIC_KEY#0', 'secret-ANTHROPIC_KEY#1']);
    expect.soft(credentialKey(H.env('ANTHROPIC_KEY', { index: 2 }))).toBe('ANTHROPIC_KEY#2');
    expect.soft(credentialRef('ANTHROPIC_KEY#2')).toEqual({ ref: 'env', name: 'ANTHROPIC_KEY', index: 2 });
    expect.soft(credentialRef('ANTHROPIC_KEY')).toEqual({ ref: 'env', name: 'ANTHROPIC_KEY' });
    expect(credentialKey(undefined)).toBe('');
  });

  it('submits a batch with indexed custom ids and collects the results in request order', async () => {
    const submitted: any[] = [];
    let polls = 0;
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith('/messages/batches') && init?.method === 'POST') {
        submitted.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ id: 'msgbatch_01' }), { status: 200 });
      }
      if (target.endsWith('/messages/batches/msgbatch_01')) {
        polls += 1;
        return new Response(JSON.stringify(polls === 1 ? { processing_status: 'in_progress' } : { processing_status: 'ended', results_url: 'https://batch.test/results' }), { status: 200 });
      }
      if (target === 'https://batch.test/results') {
        const line = (customId: string, verdict: string) =>
          JSON.stringify({ custom_id: customId, result: { type: 'succeeded', message: { model: 'claude-opus-5-5', usage: { input_tokens: 100, output_tokens: 10 }, content: [{ type: 'text', text: JSON.stringify({ result: { verdict } }) }] } } });
        return new Response(`${line('1:u1/grade#1', 'second')}\n${line('0:u1/grade#0', 'first')}\n`, { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;
    const driver = anthropic.driver({ fetch: fetchFn });
    const { jobId } = await driver.submitBatch!(
      [request(account, opus.id, { idempotencyKey: 'u1/grade#0', halts: [] }), request(account, opus.id, { idempotencyKey: 'u1/grade#1', halts: [] })],
      resolver,
    );
    expect.soft(jobId).toBe('ANTHROPIC_KEY:2:msgbatch_01');
    expect.soft(submitted[0]?.requests.map((entry: any) => entry.custom_id)).toEqual(['0:u1/grade#0', '1:u1/grade#1']);
    expect.soft(submitted[0]?.requests[0].params.model).toBe('claude-opus-5-5');
    expect.soft(await driver.collectBatch!(jobId, resolver)).toBeUndefined();
    const responses = await driver.collectBatch!(jobId, resolver);
    expect.soft(responses?.map((response) => response.output)).toEqual([{ verdict: 'first' }, { verdict: 'second' }]);
    expect(responses?.[0]?.costUsd).toBeGreaterThan(0);
  });
});
