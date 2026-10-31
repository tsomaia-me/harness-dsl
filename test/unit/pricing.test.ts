import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { H } from '../../src/dsl.js';
import { anthropicPricing, googlePricing, openaiPricing, priceListPricing } from '../../src/pricing/index.js';
import { HarnessStore } from '../../src/store.js';
import type { ExecutionContext, PricingAdapter } from '../../src/types.js';

const M = 1_000_000;
const MID_NOVEMBER_2026 = Date.UTC(2026, 10, 15);
const DECEMBER_2_2026 = Date.UTC(2026, 11, 2);

describe('Pricing adapters', () => {
  it.each([
    ['claude-opus-5-5 splits cached and uncached input', anthropicPricing, 'claude-opus-5-5', [M, M / 2, M / 10], 4.1],
    ['a platform-prefixed id matches its model', anthropicPricing, 'us.anthropic.claude-sonnet-5-5', [M, 0, M], 12],
    ['a dated snapshot matches its family', anthropicPricing, 'claude-sonnet-4-5-20250929', [M, 0, 0], 3],
    ['the shorter id is not swallowed by a longer row', anthropicPricing, 'claude-opus-5', [M, 0, 0], 5],
    ['Haiku 5.5 up to 100K prompt tokens', anthropicPricing, 'claude-haiku-5-5', [50_000, 0, 0], 0.005],
    ['Haiku 5.5 over 100K prompt tokens', anthropicPricing, 'claude-haiku-5-5', [200_000, 0, 0], 0.1],
    ['an unknown Claude model', anthropicPricing, 'claude-unknown-9', [M, 0, M], null],
    ['gpt-5.5 input and output', openaiPricing, 'gpt-5.5', [M, 0, M], 35],
    ['gpt-5 is not priced as gpt-5.5', openaiPricing, 'gpt-5', [M, 0, 0], 1.25],
    ['an unknown newer version is not billed as its predecessor', openaiPricing, 'gpt-5.7', [M, 0, 0], null],
    ['a dated gpt-4o snapshot with its own row', openaiPricing, 'gpt-4o-2024-05-13', [M, 0, 0], 5],
    ['a model without a cached rate bills cached input at the input rate', openaiPricing, 'gpt-5.5-pro', [M, M, 0], 30],
    ['gemini-2.5-pro over 200K prompt tokens', googlePricing, 'models/gemini-2.5-pro', [300_000, 0, 0], 0.75],
  ] as const)('%s', (_label, pricing: PricingAdapter, modelId, [inputTokens, cachedInputTokens, outputTokens], expected) => {
    const estimate = pricing.estimate(modelId, { inputTokens, cachedInputTokens, outputTokens }, MID_NOVEMBER_2026);
    if (expected === null) {
      expect(estimate).toBeNull();
    } else {
      expect(estimate).toBeCloseTo(expected, 9);
    }
  });

  it('prices cache writes at the cache-write rate and cache reads at the cached rate', () => {
    expect(
      anthropicPricing.estimate(
        'claude-opus-5-5',
        { inputTokens: M, cachedInputTokens: M / 4, cacheWriteTokens: M / 4, outputTokens: 0 },
        MID_NOVEMBER_2026,
      ),
    ).toBeCloseTo(0.5 * 4 + 0.25 * 0.2 + 0.25 * 5, 9);
  });

  it('matches a user price list entry whose model id has capitals', () => {
    const pricing = priceListPricing({
      source: 'internal',
      asOf: '2026-10-31',
      prices: [{ model: 'Acme-Large', inputPerMTok: 1, outputPerMTok: 1 }],
    });
    expect(pricing.estimate('Acme-Large', { inputTokens: M, cachedInputTokens: 0, outputTokens: 0 }, MID_NOVEMBER_2026)).toBe(1);
  });

  it('applies a scheduled price change from its effective date', () => {
    const usage = { inputTokens: M, cachedInputTokens: 0, outputTokens: 0 };
    expect.soft(googlePricing.estimate('gemini-4-argon', usage, MID_NOVEMBER_2026)).toBeCloseTo(2, 9);
    expect.soft(googlePricing.estimate('gemini-4-argon', usage, DECEMBER_2_2026)).toBeCloseTo(4, 9);
  });
});

describe('Cost reporting through drivers', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeContext(): { store: HarnessStore; ctx: ExecutionContext } {
    const dir = mkdtempSync(path.join(tmpdir(), 'harness-pricing-test-'));
    tempDirs.push(dir);
    const store = new HarnessStore(dir);
    store.createRun({ id: 'run-cost', flowName: 'f', workDir: dir, input: {} });
    return {
      store,
      ctx: {
        runId: 'run-cost',
        iteration: 0,
        stepName: 'step',
        projectDir: dir,
        workDir: dir,
        touchedPaths: [],
        store,
        signal: new AbortController().signal,
      },
    };
  }

  function cliReturning(result: Record<string, unknown>) {
    return H.drivers.claudeCli({
      spawnBridge: async (_args, _env, _cwd, onLine) => {
        onLine(
          JSON.stringify({
            type: 'assistant',
            message: { usage: { input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 1000 } },
          }),
        );
        onLine(JSON.stringify({ type: 'result', structured_output: { ok: true }, ...result }));
        return { exitCode: 0, stderr: '' };
      },
    });
  }

  const skill = H.skill('s').input(z.object({})).output(z.object({ ok: z.boolean() }));

  it('records the cost the claude CLI reports over the table estimate', async () => {
    const { store, ctx } = makeContext();
    const agent = H.agent('a').model(H.model(H.account('cli', cliReturning({ total_cost_usd: 0.0028309 })), 'claude-opus-5-5'));
    await agent.run(skill).execute({}, ctx);
    expect(store.listInvocations('run-cost')[0]?.equivalentCostUsd).toBe(0.0028309);
    store.close();
  });

  it('prefers the model pricing override to the cost the claude CLI reports', async () => {
    const { store, ctx } = makeContext();
    const flat: PricingAdapter = { estimate: () => 7 };
    const agent = H.agent('a').model(
      H.model(H.account('cli', cliReturning({ total_cost_usd: 0.0028309 })), 'claude-opus-5-5').pricing(flat),
    );
    await agent.run(skill).execute({}, ctx);
    expect(store.listInvocations('run-cost')[0]?.equivalentCostUsd).toBe(7);
    store.close();
  });

  it('uses the model pricing override, and records an unpriced model as unknown in TELEMETRY.md', async () => {
    const { store, ctx } = makeContext();
    const account = H.account('cli', cliReturning({}));
    const flatRate: PricingAdapter = { estimate: (_id, usage) => usage.outputTokens / 1000 };

    await H.agent('priced').model(H.model(account, 'in-house-model').pricing(flatRate)).run(skill).execute({}, ctx);
    await H.agent('unpriced').model(H.model(account, 'in-house-model')).run(skill).execute({}, ctx);

    const [priced, unpriced] = store.listInvocations('run-cost');
    expect.soft(priced?.equivalentCostUsd).toBe(1);
    expect.soft(unpriced?.equivalentCostUsd).toBeNull();
    store.updateRunProgress('run-cost', { status: 'completed', finishedAtMs: Date.now() });
    const telemetry = readFileSync(store.telemetryPath, 'utf8');
    expect.soft(telemetry).toContain('- Total Subscription-Equivalent Value: $1.0000 + unpriced');
    expect.soft(telemetry).toMatch(/\| `unpriced` \| .* \| \$0\.0000 \(—\) \|/);
    store.close();
  });
});
