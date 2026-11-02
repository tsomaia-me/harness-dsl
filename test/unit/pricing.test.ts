import { describe, expect, it } from 'vitest';
import { anthropicPricing, googlePricing, openaiPricing, priceListPricing } from '../../src/pricing/index.js';
import type { PricingAdapter } from '../../src/types.js';

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
