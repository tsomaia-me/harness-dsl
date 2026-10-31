import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { H } from '../../src/dsl.js';
import { RateLimitedError } from '../../src/quota.js';
import {
  anthropicRateLimits,
  composeRateLimits,
  googleRateLimits,
  ietfRateLimits,
  openaiRateLimits,
} from '../../src/rate-limits/index.js';
import { HarnessStore } from '../../src/store.js';
import type { DriverInvokeRequest, ExecutionContext, RateLimitAdapter } from '../../src/types.js';

const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);

const capturedRateLimitEvent = JSON.parse(
  readFileSync(path.join(import.meta.dirname, '../fixtures/claude-cli-rate-limit-event.json'), 'utf8'),
) as Record<string, any>;

function invokeRequest(): DriverInvokeRequest {
  return {
    accountId: 'acct',
    modelId: 'model-x',
    modelOptions: {},
    systemPrompt: '',
    userPrompt: 'do it',
    outputJsonSchema: { type: 'object' },
    workDir: tmpdir(),
    runId: 'run-rl',
    stepName: 'step',
    inactivityTimeoutMs: 5_000,
    signal: new AbortController().signal,
  };
}

function cliEmitting(lines: readonly unknown[], exitCode = 0) {
  return H.drivers.claudeCli({
    spawnBridge: async (_args, _env, _cwd, onLine) => {
      for (const line of lines) onLine(JSON.stringify(line));
      return { exitCode, stderr: '' };
    },
  });
}

describe('Rate-limit adapters', () => {
  it.each([
    {
      adapter: 'anthropic',
      parse: anthropicRateLimits,
      headers: {
        'anthropic-ratelimit-unified-5h-utilization': '0.42',
        'anthropic-ratelimit-unified-5h-reset': '1793455200',
        'anthropic-ratelimit-unified-7d-utilization': '0.71',
        'anthropic-ratelimit-unified-7d-reset': '1793980800',
        'anthropic-ratelimit-requests-limit': '50',
        'anthropic-ratelimit-requests-remaining': '10',
        'anthropic-ratelimit-requests-reset': '2026-10-31T12:01:00Z',
        'retry-after': '30',
      },
      expected: {
        windows: [
          { id: 'anthropic:5h', utilization: 0.42, resetsAtMs: 1_793_455_200_000 },
          { id: 'anthropic:7d', utilization: 0.71, resetsAtMs: 1_793_980_800_000 },
          { id: 'anthropic:requests', utilization: 0.8, resetsAtMs: Date.UTC(2026, 9, 31, 12, 1, 0) },
        ],
        cooldownUntilMs: NOW + 30_000,
      },
    },
    {
      adapter: 'openai',
      parse: openaiRateLimits,
      headers: {
        'x-ratelimit-limit-requests': '60',
        'x-ratelimit-remaining-requests': '0',
        'x-ratelimit-reset-requests': '6m0s',
        'x-ratelimit-limit-tokens': '150000',
        'x-ratelimit-remaining-tokens': '120000',
        'x-ratelimit-reset-tokens': '1h2m3.5s',
        'retry-after-ms': '1500',
      },
      expected: {
        windows: [
          { id: 'openai:requests', utilization: 1, resetsAtMs: NOW + 360_000 },
          { id: 'openai:tokens', utilization: 0.2, resetsAtMs: NOW + 3_723_500 },
        ],
        cooldownUntilMs: NOW + 1_500,
      },
    },
    {
      adapter: 'openai, sub-second reset',
      parse: openaiRateLimits,
      headers: {
        'x-ratelimit-limit-tokens': '1000',
        'x-ratelimit-remaining-tokens': '750',
        'x-ratelimit-reset-tokens': '500ms',
      },
      expected: {
        windows: [{ id: 'openai:tokens', utilization: 0.25, resetsAtMs: NOW + 500 }],
      },
    },
    {
      adapter: 'ietf, mixed-case names and HTTP-date Retry-After',
      parse: ietfRateLimits,
      headers: {
        'RateLimit-Limit': '100',
        'RateLimit-Remaining': '25',
        'RateLimit-Reset': '30',
        'Retry-After': 'Sat, 31 Oct 2026 12:05:00 GMT',
      },
      expected: {
        windows: [{ id: 'http:ratelimit', utilization: 0.75, resetsAtMs: NOW + 30_000 }],
        cooldownUntilMs: Date.UTC(2026, 9, 31, 12, 5, 0),
      },
    },
    {
      adapter: 'ietf, no rate-limit headers',
      parse: ietfRateLimits,
      headers: { 'content-type': 'application/json' },
      expected: {},
    },
  ])('$adapter headers parse into quota windows', ({ parse, headers, expected }) => {
    expect(parse.fromResponse({ status: 200, headers }, NOW)).toStrictEqual(expected);
  });

  it.each([
    { label: 'RetryInfo seconds', retryDelay: '37s', expected: NOW + 37_000 },
    { label: 'RetryInfo fractional seconds', retryDelay: '1.5s', expected: NOW + 1_500 },
  ])('reads the Gemini 429 body ($label)', ({ retryDelay, expected }) => {
    const body = {
      error: {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        details: [
          { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel' }] },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay },
        ],
      },
    };
    expect(googleRateLimits.fromResponse({ status: 429, headers: {}, body }, NOW)).toStrictEqual({ cooldownUntilMs: expected });
  });

  it('composes adapters, keeping the last adapter\'s window per id and the latest cooldown', () => {
    const first: RateLimitAdapter = {
      fromResponse: () => ({ windows: [{ id: 'shared', utilization: 0.1 }, { id: 'first-only', utilization: 0.2 }], cooldownUntilMs: NOW + 20_000 }),
    };
    const second: RateLimitAdapter = {
      fromResponse: () => ({ windows: [{ id: 'shared', utilization: 0.5 }], cooldownUntilMs: NOW + 10_000 }),
    };
    expect(composeRateLimits(first, second).fromResponse({ status: 429, headers: {} }, NOW)).toStrictEqual({
      windows: [
        { id: 'shared', utilization: 0.5 },
        { id: 'first-only', utilization: 0.2 },
      ],
      cooldownUntilMs: NOW + 20_000,
    });
  });
});

describe('Rate-limit detection in drivers', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('reports both subscription windows from the claude CLI rate_limit_event', async () => {
    const driver = cliEmitting([
      capturedRateLimitEvent,
      { type: 'result', structured_output: { ok: true } },
    ]);
    const result = await driver.invoke(invokeRequest());
    expect(result.quotaHint).toStrictEqual({
      windows: [
        { id: 'anthropic:5h', utilization: 0.13, resetsAtMs: 1_793_455_200_000 },
        { id: 'anthropic:7d', utilization: 0.12, resetsAtMs: 1_793_980_800_000 },
      ],
    });
  });

  it('does not treat a successful claude CLI run whose text mentions rate limits as rate limited', async () => {
    const driver = cliEmitting([
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Added a 429 rate limit guard with retry after 5 minutes.' }] },
      },
      { type: 'result', structured_output: { ok: true }, is_error: false },
    ]);
    await expect(driver.invoke(invokeRequest())).resolves.toMatchObject({
      structuredOutput: { ok: true },
    });
  });

  it('does not treat a failed turn whose error names a rate_limiter module as rate limited', async () => {
    const driver = cliEmitting(
      [{ type: 'result', is_error: true, result: "Error: Cannot find module './rate_limiter' imported from src/server.ts" }],
      1,
    );
    const error = await driver.invoke(invokeRequest()).catch((err: unknown) => err);
    expect.soft(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RateLimitedError);
  });

  it('raises RateLimitedError with the rejected window reset when the claude CLI turn ends in a 429', async () => {
    const rejected = {
      ...capturedRateLimitEvent,
      rate_limit_info: {
        ...capturedRateLimitEvent.rate_limit_info,
        status: 'rejected',
        rateLimitType: 'seven_day',
        resetsAt: 1793980800,
      },
    };
    const driver = cliEmitting(
      [rejected, { type: 'result', is_error: true, api_error_status: 429, result: 'API Error' }],
      1,
    );
    const error = await driver.invoke(invokeRequest()).catch((err: unknown) => err);
    expect.soft(error).toBeInstanceOf(RateLimitedError);
    expect.soft((error as RateLimitedError).quota.cooldownUntilMs).toBe(1_793_980_800_000);
  });

  it('reads the Gemini retry delay from the 429 body through the AI SDK driver', async () => {
    const customFetch = (async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 429,
            message: 'Resource exhausted',
            status: 'RESOURCE_EXHAUSTED',
            details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '42s' }],
          },
        }),
        { status: 429, headers: { 'content-type': 'application/json', 'retry-after-ms': '0' } },
      )) as typeof fetch;
    const driver = H.drivers.aiSdk({ provider: 'google', apiKey: 'test-key', customFetch });
    const before = Date.now();
    const error = await driver.invoke(invokeRequest()).catch((err: unknown) => err);
    expect.soft(error).toBeInstanceOf(RateLimitedError);
    expect((error as RateLimitedError).quota.cooldownUntilMs ?? 0).toBeGreaterThanOrEqual(before + 42_000);
  });

  it('unwraps the AI SDK retry error so the 429 response headers reach the quota', async () => {
    let calls = 0;
    const customFetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: 'Rate limit reached', type: 'requests' } }), {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after-ms': '0',
          'x-ratelimit-limit-requests': '60',
          'x-ratelimit-remaining-requests': '0',
          'x-ratelimit-reset-requests': '6m0s',
        },
      });
    }) as typeof fetch;
    const driver = H.drivers.aiSdk({ provider: 'openai', apiKey: 'test-key', customFetch });

    const error = await driver.invoke(invokeRequest()).catch((err: unknown) => err);
    expect.soft(calls).toBeGreaterThan(1);
    expect.soft(error).toBeInstanceOf(RateLimitedError);
    expect.soft((error as RateLimitedError).quota.windows).toEqual([
      { id: 'openai:requests', utilization: 1, resetsAtMs: expect.any(Number) },
    ]);
  });

  it('cools an account down for its policy default when the rate limit names no reset, then fails over', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harness-rl-test-'));
    tempDirs.push(dir);
    const store = new HarnessStore(dir);
    store.createRun({ id: 'run-rl', flowName: 'f', workDir: dir, input: {} });
    const ctx: ExecutionContext = {
      runId: 'run-rl',
      iteration: 0,
      stepName: 'step',
      projectDir: dir,
      workDir: dir,
      touchedPaths: [],
      store,
      signal: new AbortController().signal,
    };
    const limited = H.account(
      'limited',
      H.drivers.custom({
        invoke: async (req) => {
          throw new RateLimitedError(req.accountId, 'limited, no reset given');
        },
      }),
    ).quotaPolicy({ defaultCooldownMs: 300_000 });
    const healthy = H.account('healthy', H.drivers.mock({ responses: [{ structuredOutput: { ok: true } }] }));
    const agent = H.agent('worker').model(
      H.model(H.pool('p', [limited, healthy]).strategy('priority'), 'model-x'),
    );
    const skill = H.skill('s').input(z.object({})).output(z.object({ ok: z.boolean() }));

    const startedAt = Date.now();
    await expect(agent.run(skill).execute({}, ctx)).resolves.toEqual({ ok: true });
    const cooldown = store.getAccountQuota('limited')?.cooldownUntilMs ?? 0;
    expect.soft(cooldown).toBeGreaterThanOrEqual(startedAt + 300_000);
    expect.soft(cooldown).toBeLessThan(startedAt + 360_000);
    store.close();
  });
});
