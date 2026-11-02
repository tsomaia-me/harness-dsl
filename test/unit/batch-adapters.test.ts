import { describe, expect, it } from 'vitest';
import { googleBatchAdapter } from '../../src/batch/google.js';
import { openrouterBatchAdapter } from '../../src/batch/openrouter.js';
import { google } from '../../src/adapters/google/index.js';
import { openrouter } from '../../src/adapters/openrouter/index.js';
import { H } from '../../src/dsl/index.js';
import type { ModelRequest, Resolver } from '../../src/kernel/index.js';
import type { PricingAdapter } from '../../src/types.js';
import { fakeQuota } from './scenarios/doubles.js';

const SCHEMA = { type: 'object', properties: { severity: { type: 'string' } }, required: ['severity'], additionalProperties: false };
const tenCentsPerCall: PricingAdapter = { estimate: () => 0.1 };
const resolver: Resolver = { env: (ref) => `secret-${ref.name}`, port: () => 0 };

type Call = { readonly url: string; readonly method: string; readonly headers: Record<string, string>; readonly body: any };

function recorder(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = { url: String(url), method: init?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers).entries()), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return { calls, fetchFn };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('the OpenRouter batch adapter', () => {
  function openrouterFetch(polls: unknown[]) {
    let polled = 0;
    return recorder((call) => {
      if (call.url === 'https://openrouter.ai/api/v1/batches' && call.method === 'POST') return json({ id: 'batch_01', object: 'batch', status: 'validating' }, 202);
      if (call.url === 'https://openrouter.ai/api/v1/batches/batch_01') return json(polls[Math.min(polled++, polls.length - 1)]);
      return new Response('Not found', { status: 404 });
    });
  }

  const completed = {
    id: 'batch_01',
    status: 'completed',
    usage: { prompt_tokens: 300, completion_tokens: 40, total_tokens: 340, cost: 0.0042 },
    results: [
      { id: 'r2', custom_id: 'item-1', response: null, error: { type: 'invalid_request', message: 'too long', param: null, error_type: 'upstream' } },
      {
        id: 'r1',
        custom_id: 'item-0',
        response: { status_code: 200, request_id: 'req-1', body: { id: 'gen-1', model: 'openai/gpt-5.5', choices: [{ message: { role: 'assistant', content: '{"severity":"low"}' } }], usage: { prompt_tokens: 200, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 50 } } } },
        error: null,
      },
    ],
  };

  it('submits chat completions with a JSON schema response format, polls, and maps results by custom id', async () => {
    const { calls, fetchFn } = openrouterFetch([{ id: 'batch_01', status: 'in_progress' }, completed]);
    const batch = openrouterBatchAdapter({ apiKey: () => 'or-key', fetch: fetchFn, pricing: tenCentsPerCall, discount: 0.5 });
    const { batchId } = await batch.submit(
      [
        { customId: 'item-0', systemPrompt: 'Audit', userPrompt: 'Check a.ts', outputJsonSchema: SCHEMA },
        { customId: 'item-1', systemPrompt: 'Audit', userPrompt: 'Check b.ts', outputJsonSchema: SCHEMA },
      ],
      'openai/gpt-5.5',
      { effort: 'low' },
    );
    expect.soft(batchId).toBe('batch_01');
    const submit = calls[0]!;
    expect.soft(submit.headers.authorization).toBe('Bearer or-key');
    expect.soft(Object.keys(submit.body)).toEqual(['endpoint', 'model', 'completion_window', 'requests']);
    expect.soft(submit.body).toMatchObject({ endpoint: '/v1/chat/completions', model: 'openai/gpt-5.5', completion_window: '24h' });
    expect.soft(submit.body.requests[0]).toEqual({
      custom_id: 'item-0',
      body: {
        model: 'openai/gpt-5.5',
        messages: [
          { role: 'system', content: 'Audit' },
          { role: 'user', content: 'Check a.ts' },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'output', schema: SCHEMA, strict: true } },
        reasoning: { effort: 'low' },
      },
    });
    expect.soft(await batch.poll(batchId)).toEqual({ status: 'running' });
    const done = await batch.poll(batchId);
    expect.soft(done.status).toBe('completed');
    expect.soft(done.results?.map((item) => [item.customId, item.ok, item.structuredOutput ?? item.error])).toEqual([
      ['item-1', false, 'invalid_request: too long'],
      ['item-0', true, { severity: 'low' }],
    ]);
    expect.soft(done.results?.[1]?.usage).toEqual({ inputTokens: 200, cachedInputTokens: 50, cacheWriteTokens: 0, outputTokens: 30, actualCostUsd: 0.05, equivalentCostUsd: 0.1 });
    expect(done.results?.[0]?.usage.actualCostUsd).toBe(0);
  });

  it('reports a failed or expired batch', async () => {
    const { fetchFn } = openrouterFetch([{ id: 'batch_01', status: 'failed', error: { message: 'no batch endpoint for this model' } }]);
    const batch = openrouterBatchAdapter({ apiKey: () => 'or-key', fetch: fetchFn, pricing: tenCentsPerCall });
    expect(await batch.poll('batch_01')).toEqual({ status: 'failed' });
  });
});

describe('the Gemini batch adapter', () => {
  const inline = (key: string, text: string | undefined, error?: unknown) => ({
    metadata: { key },
    ...(error ? { error } : { response: { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 10, cachedContentTokenCount: 20 }, modelVersion: 'gemini-2.5-flash-lite' } }),
  });

  function geminiFetch(polls: unknown[]) {
    let polled = 0;
    return recorder((call) => {
      if (call.url === 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:batchGenerateContent' && call.method === 'POST') return json({ name: 'batches/abc123', metadata: { state: 'BATCH_STATE_PENDING' }, done: false });
      if (call.url === 'https://generativelanguage.googleapis.com/v1beta/batches/abc123') return json(polls[Math.min(polled++, polls.length - 1)]);
      return new Response('Not found', { status: 404 });
    });
  }

  it('submits inline requests with JSON output, polls the operation, and maps inline responses by key', async () => {
    const { calls, fetchFn } = geminiFetch([
      { name: 'batches/abc123', metadata: { state: 'BATCH_STATE_RUNNING' }, done: false },
      { name: 'batches/abc123', metadata: { state: 'BATCH_STATE_SUCCEEDED' }, done: true, response: { inlinedResponses: { inlinedResponses: [inline('item-1', undefined, { code: 3, message: 'blocked' }), inline('item-0', '{"severity":"low"}')] } } },
    ]);
    const batch = googleBatchAdapter({ apiKey: () => 'g-key', fetch: fetchFn, pricing: tenCentsPerCall, discount: 0.5 });
    const { batchId } = await batch.submit(
      [
        { customId: 'item-0', systemPrompt: 'Audit', userPrompt: 'Check a.ts', outputJsonSchema: SCHEMA },
        { customId: 'item-1', systemPrompt: 'Audit', userPrompt: 'Check b.ts', outputJsonSchema: SCHEMA },
      ],
      'gemini-2.5-flash-lite',
      { thinkingBudget: 0 },
    );
    expect.soft(batchId).toBe('batches/abc123');
    const submit = calls[0]!;
    expect.soft(submit.headers['x-goog-api-key']).toBe('g-key');
    expect.soft(submit.body.batch.display_name).toMatch(/^harness-/);
    expect.soft(submit.body.batch.input_config.requests.requests[0]).toEqual({
      request: {
        system_instruction: { parts: [{ text: 'Audit' }] },
        contents: [{ role: 'user', parts: [{ text: 'Check a.ts' }] }],
        generation_config: { response_mime_type: 'application/json', response_json_schema: SCHEMA, thinking_config: { thinking_budget: 0 } },
      },
      metadata: { key: 'item-0' },
    });
    expect.soft(await batch.poll(batchId)).toEqual({ status: 'running' });
    const done = await batch.poll(batchId);
    expect.soft(done.status).toBe('completed');
    expect.soft(done.results?.map((item) => [item.customId, item.ok, item.structuredOutput ?? item.error])).toEqual([
      ['item-1', false, '3: blocked'],
      ['item-0', true, { severity: 'low' }],
    ]);
    expect(done.results?.[1]?.usage).toEqual({ inputTokens: 120, cachedInputTokens: 20, cacheWriteTokens: 0, outputTokens: 10, actualCostUsd: 0.05, equivalentCostUsd: 0.1 });
  });

  it('reports a failed, cancelled or expired batch', async () => {
    const { fetchFn } = geminiFetch([{ name: 'batches/abc123', metadata: { state: 'BATCH_STATE_EXPIRED' }, done: true, error: { code: 4, message: 'expired' } }]);
    const batch = googleBatchAdapter({ apiKey: () => 'g-key', fetch: fetchFn, pricing: tenCentsPerCall });
    expect(await batch.poll('batches/abc123')).toEqual({ status: 'failed' });
  });
});

describe('the google and openrouter model adapters', () => {
  const quota = fakeQuota('q');

  function request(account: ModelRequest['account'], model: string, key: string): ModelRequest {
    return { seat: 'grader', model, account, role: { name: 'grader', intents: [], prompt: 'grade it' }, input: {}, memory: [], halts: [], outputSchema: SCHEMA, idempotencyKey: key };
  }

  it('declare accounts and batch-capable models and submit batches through their presets', async () => {
    const gAccount = google.account('gemini', { apiKey: H.env('GEMINI_KEY'), quota });
    const gModel = google.model('flash', { id: 'gemini-2.5-flash-lite' });
    expect.soft(gAccount).toMatchObject({ entity: 'account', driver: 'google', credential: { ref: 'env', name: 'GEMINI_KEY' } });
    expect.soft(gModel).toMatchObject({ entity: 'model', driver: 'google', batch: true });
    const gCalls: Call[] = [];
    const gDriver = google.driver({
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        gCalls.push({ url: String(url), method: init?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers).entries()), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return json({ name: 'batches/g1', done: false });
      }) as typeof fetch,
    });
    expect.soft(gDriver).toMatchObject({ driver: 'google', hooks: false });
    expect.soft(await gDriver.submitBatch!([request(gAccount, gModel.id, 'u1/grade#0')], resolver)).toEqual({ jobId: 'GEMINI_KEY:batches/g1' });
    expect.soft(gCalls[0]?.headers['x-goog-api-key']).toBe('secret-GEMINI_KEY');
    expect.soft(gCalls[0]?.body.batch.input_config.requests.requests[0].metadata.key).toBe('0:u1/grade#0');

    const orAccount = openrouter.account('router', { apiKey: H.env('OPEN_ROUTER_API_KEY'), quota });
    const orModel = openrouter.model('gpt', { id: 'openai/gpt-5.5' });
    expect.soft(orModel).toMatchObject({ entity: 'model', driver: 'openrouter', batch: true });
    const orCalls: Call[] = [];
    const orDriver = openrouter.driver({
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        orCalls.push({ url: String(url), method: init?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers).entries()), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return json({ id: 'batch_9', status: 'validating' }, 202);
      }) as typeof fetch,
    });
    expect.soft(await orDriver.submitBatch!([request(orAccount, orModel.id, 'u1/grade#0')], resolver)).toEqual({ jobId: 'OPEN_ROUTER_API_KEY:batch_9' });
    expect.soft(orCalls[0]?.url).toBe('https://openrouter.ai/api/v1/batches');
    expect(orCalls[0]?.headers.authorization).toBe('Bearer secret-OPEN_ROUTER_API_KEY');
  });
});
