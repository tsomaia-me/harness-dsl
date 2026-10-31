import { tmpdir } from 'node:os';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { anthropicBatchAdapter } from '../../src/batch/anthropic.js';
import { H } from '../../src/dsl.js';
import { anthropicPricing } from '../../src/pricing/index.js';
import { anthropicPreset, googlePreset, openaiPreset } from '../../src/presets/index.js';
import type { DriverInvokeRequest, PricingAdapter } from '../../src/types.js';

const SCHEMA = {
  type: 'object',
  properties: { severity: { type: 'string' } },
  required: ['severity'],
  additionalProperties: false,
};

function invokeRequest(modelId: string): DriverInvokeRequest {
  return {
    accountId: 'acct',
    modelId,
    modelOptions: {},
    systemPrompt: 'You audit files.',
    userPrompt: 'Audit file.ts',
    outputJsonSchema: SCHEMA,
    workDir: tmpdir(),
    runId: 'run-preset',
    stepName: 'step',
    inactivityTimeoutMs: 5_000,
    signal: new AbortController().signal,
  };
}

describe('Provider presets', () => {
  it('runs any AI SDK model through a user preset, with no first-party pricing or key lookup', async () => {
    const seenModelIds: string[] = [];
    const driver = H.drivers.aiSdk({
      provider: {
        name: 'in-house',
        createModel: (modelId) => {
          seenModelIds.push(modelId);
          return new MockLanguageModelV3({
            doGenerate: async () => ({
              content: [{ type: 'text', text: '{"severity":"low"}' }],
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: { total: 100, noCache: 50, cacheRead: 30, cacheWrite: 20 },
                outputTokens: { total: 20, text: 20, reasoning: 0 },
              },
              warnings: [],
            }),
          });
        },
      },
    });

    const result = await driver.invoke(invokeRequest('anthropic.claude-opus-5-5'));
    expect.soft(seenModelIds).toEqual(['anthropic.claude-opus-5-5']);
    expect.soft(result.structuredOutput).toEqual({ severity: 'low' });
    expect.soft(result.usage.equivalentCostUsd).toBeNull();
    expect.soft(result.usage).toMatchObject({ inputTokens: 100, cachedInputTokens: 30, cacheWriteTokens: 20, outputTokens: 20 });
    expect.soft(driver.batch).toBeUndefined();
  });

  it.each([
    { preset: anthropicPreset, options: { effort: 'high', cachePrefix: true }, expected: { anthropic: { effort: 'high', cacheControl: { type: 'ephemeral' } } } },
    { preset: openaiPreset, options: { effort: 'low' }, expected: { openai: { reasoningEffort: 'low' } } },
    { preset: googlePreset, options: { thinkingBudget: 8192 }, expected: { google: { thinkingConfig: { thinkingBudget: 8192 } } } },
    { preset: googlePreset, options: {}, expected: undefined },
  ])('$preset.name maps model options to provider options', ({ preset, options, expected }) => {
    expect(preset.mapModelOptions?.(options)).toStrictEqual(expected);
  });
});

describe('Anthropic batch adapter', () => {
  function recordingFetch(resultMessage: Record<string, unknown>) {
    const submitted: { body: any; headers: Record<string, string> }[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.endsWith('/messages/batches') && init?.method === 'POST') {
        submitted.push({ body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
        return new Response(JSON.stringify({ id: 'msgbatch_01' }), { status: 200 });
      }
      if (urlStr.endsWith('/messages/batches/msgbatch_01')) {
        return new Response(
          JSON.stringify({ processing_status: 'ended', results_url: 'https://batch.test/results' }),
          { status: 200 },
        );
      }
      if (urlStr === 'https://batch.test/results') {
        const line = JSON.stringify({ custom_id: 'item-0', result: { type: 'succeeded', message: resultMessage } });
        return new Response(`${line}\n`, { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;
    return { submitted, fetchFn };
  }

  const tenCentsPerCall: PricingAdapter = { estimate: () => 0.1 };
  const usage = { input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 200 };

  it.each([
    {
      structuredOutput: 'output-format' as const,
      message: { model: 'claude-opus-5-5', usage, content: [{ type: 'text', text: '{"severity":"low"}' }] },
      expectedParams: {
        output_config: { format: { type: 'json_schema', schema: SCHEMA }, effort: 'high' },
      },
    },
    {
      structuredOutput: 'forced-tool' as const,
      message: {
        model: 'claude-sonnet-4-6',
        usage,
        content: [{ type: 'tool_use', name: 'structured_output', input: { severity: 'low' } }],
      },
      expectedParams: {
        output_config: { effort: 'high' },
        tools: [{ name: 'structured_output', description: expect.any(String), input_schema: SCHEMA }],
        tool_choice: { type: 'tool', name: 'structured_output' },
      },
    },
  ])('submits $structuredOutput requests with mapped model options and prices results at its discount', async ({ structuredOutput, message, expectedParams }) => {
    const { submitted, fetchFn } = recordingFetch(message);
    const batch = anthropicBatchAdapter({
      apiKey: () => 'test-key',
      fetch: fetchFn,
      pricing: tenCentsPerCall,
      structuredOutput,
      maxTokens: 2048,
      apiVersion: '2026-10-21',
      discount: 0.25,
    });

    await batch.submit(
      [{ customId: 'item-0', systemPrompt: 'Audit', userPrompt: 'Check file.ts', outputJsonSchema: SCHEMA }],
      'claude-opus-5-5',
      { effort: 'high' },
    );
    const params = submitted[0]?.body.requests[0].params;
    expect.soft(submitted[0]?.headers['anthropic-version']).toBe('2026-10-21');
    expect.soft(params).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 2048, ...expectedParams });
    if (structuredOutput === 'output-format') {
      expect.soft(params).not.toHaveProperty('tool_choice');
    }

    const polled = await batch.poll('msgbatch_01');
    expect.soft(polled.results?.[0]?.structuredOutput).toEqual({ severity: 'low' });
    expect.soft(polled.results?.[0]?.usage.equivalentCostUsd).toBe(0.1);
    expect.soft(polled.results?.[0]?.usage.actualCostUsd).toBe(0.025);
  });

  it('counts cache reads and writes as input and prices each at its own rate', async () => {
    const { fetchFn } = recordingFetch({
      model: 'claude-sonnet-4-5',
      usage: { input_tokens: 1_000, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 2_000, output_tokens: 0 },
      content: [{ type: 'text', text: '{"severity":"low"}' }],
    });
    const batch = anthropicBatchAdapter({ apiKey: () => 'k', pricing: anthropicPricing, fetch: fetchFn });
    const usage = (await batch.poll('msgbatch_01')).results?.[0]?.usage;
    expect.soft(usage).toMatchObject({ inputTokens: 12_000, cachedInputTokens: 9_000, cacheWriteTokens: 2_000 });
    expect(usage?.equivalentCostUsd).toBeCloseTo((1_000 * 3 + 9_000 * 0.3 + 2_000 * 3.75) / 1e6, 9);
  });

  it.each([
    { label: 'the driver pricing option', driverPricing: { estimate: () => 0.1 }, submitPricing: undefined, expected: 0.1 },
    { label: 'the pricing passed with the batch', driverPricing: undefined, submitPricing: { estimate: () => 0.3 }, expected: 0.3 },
  ])('prices AI SDK batch results with $label', async ({ driverPricing, submitPricing, expected }) => {
    const { fetchFn } = recordingFetch({
      model: 'claude-opus-5-5',
      usage: { input_tokens: 1_000, cache_read_input_tokens: 0, output_tokens: 200 },
      content: [{ type: 'text', text: '{"severity":"low"}' }],
    });
    const driver = H.drivers.aiSdk({ provider: 'anthropic', apiKey: 'k', fetch: fetchFn, pricing: driverPricing });
    const { batchId } = await driver.batch!.submit(
      [{ customId: 'item-0', systemPrompt: 'Audit', userPrompt: 'x', outputJsonSchema: SCHEMA }],
      'claude-opus-5-5',
      {},
      submitPricing,
    );
    expect((await driver.batch!.poll(batchId)).results?.[0]?.usage.equivalentCostUsd).toBe(expected);
  });

  it('is the anthropic driver default and can be turned off', () => {
    expect.soft(H.drivers.aiSdk({ provider: 'anthropic', apiKey: 'k' }).batch).toBeDefined();
    expect.soft(H.drivers.aiSdk({ provider: 'anthropic', apiKey: 'k', batch: false }).batch).toBeUndefined();
  });
});
