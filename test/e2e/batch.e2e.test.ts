import { describe, expect, it } from 'vitest';
import { google } from '../../src/adapters/google/index.js';
import { openrouter } from '../../src/adapters/openrouter/index.js';
import { H } from '../../src/dsl/index.js';
import { processResolver } from '../../src/engine/resolver.js';
import type { ModelDriver, ModelRequest, ModelResponse } from '../../src/kernel/index.js';
import { fakeQuota } from '../unit/scenarios/doubles.js';

const live = process.env.HARNESS_LIVE === '1';
const schema = { type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false };
const POLL_MS = 20_000;
const WAIT_MS = 7 * 60_000;

async function collectWithin(driver: ModelDriver, jobId: string, resolver: ReturnType<typeof processResolver>): Promise<readonly ModelResponse[] | undefined> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const results = await driver.collectBatch!(jobId, resolver);
    if (results || Date.now() >= deadline) return results;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

describe.skipIf(!live)('a live batch', () => {
  it('on Gemini: submits two requests, polls, and collects typed results with their list price', { timeout: 9 * 60_000 }, async () => {
    const resolver = processResolver();
    const account = google.account('gemini', { apiKey: H.env('GEMINI_API_KEY'), quota: fakeQuota('q') });
    const driver = google.driver();
    const request = (key: string, a: number, b: number): ModelRequest => ({
      seat: 'adder',
      model: 'gemini-3.5-flash-lite',
      account,
      role: { name: 'adder', intents: [], prompt: `What is ${a} + ${b}? Put the number in "value".` },
      input: { a, b },
      memory: [],
      halts: [],
      outputSchema: schema,
      idempotencyKey: key,
    });
    const { jobId } = await driver.submitBatch!([request('e2e/add#0', 2, 3), request('e2e/add#1', 10, 5)], resolver);
    process.stdout.write(`gemini batch job ${jobId}\n`);
    expect.soft(jobId).toMatch(/^GEMINI_API_KEY:2:batches\//);
    const results = await collectWithin(driver, jobId, resolver);
    if (!results) {
      process.stdout.write(`gemini batch still running after ${WAIT_MS / 60_000} minutes: submission and polling verified, collection not\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify(results)}\n`);
    expect.soft(results.map((response) => response.output)).toEqual([{ value: 5 }, { value: 15 }]);
    expect(results.every((response) => typeof response.costUsd === 'number' && typeof response.equivalentUsd === 'number')).toBe(true);
  });

  it('on OpenRouter: submits two requests to a cheap model, polls, and collects results charged from the batch cost', { timeout: 9 * 60_000 }, async () => {
    const resolver = processResolver();
    const account = openrouter.account('router', { apiKey: H.env('OPEN_ROUTER_API_KEY'), quota: fakeQuota('q') });
    const driver = openrouter.driver();
    const request = (key: string, a: number, b: number): ModelRequest => ({
      seat: 'adder',
      model: 'openai/gpt-oss-20b',
      account,
      role: { name: 'adder', intents: [], prompt: `What is ${a} + ${b}? Put the number in "value".` },
      input: { a, b },
      memory: [],
      halts: [],
      outputSchema: schema,
      idempotencyKey: key,
    });
    /** `HARNESS_OPENROUTER_BATCH_JOB=<job id>` collects a batch submitted earlier instead of submitting a new one. */
    const jobId = process.env.HARNESS_OPENROUTER_BATCH_JOB ?? (await driver.submitBatch!([request('e2e/add#0', 2, 3), request('e2e/add#1', 10, 5)], resolver)).jobId;
    process.stdout.write(`openrouter batch job ${jobId}\n`);
    expect.soft(jobId).toMatch(/^OPEN_ROUTER_API_KEY:2:/);
    const results = await collectWithin(driver, jobId, resolver);
    if (!results) {
      process.stdout.write(`openrouter batch still running after ${WAIT_MS / 60_000} minutes: submission and polling verified, collection not\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify(results)}\n`);
    expect.soft(results).toHaveLength(2);
    expect.soft(results[0]?.output).toEqual({ value: 5 });
    // The charge comes from the batch's reported cost; a list price needs a priced model, which `gpt-oss-20b` is not.
    expect(results.every((response) => typeof response.costUsd === 'number' && response.costUsd > 0)).toBe(true);
  });
});
