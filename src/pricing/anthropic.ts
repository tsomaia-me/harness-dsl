import { type PriceList, priceListPricing } from './table.js';

export const ANTHROPIC_PRICE_LIST: PriceList = {
  source: 'https://platform.claude.com/docs/en/about-claude/pricing',
  asOf: '2026-10-31',
  prices: [
    { model: 'claude-fable-5-1', inputPerMTok: 10, cachedInputPerMTok: 0.25, outputPerMTok: 50 },
    { model: 'claude-mythos-5-1', inputPerMTok: 10, cachedInputPerMTok: 0.25, outputPerMTok: 50 },
    { model: 'claude-fable-5', inputPerMTok: 10, cachedInputPerMTok: 1, outputPerMTok: 50 },
    { model: 'claude-mythos-5', inputPerMTok: 10, cachedInputPerMTok: 1, outputPerMTok: 50 },
    { model: 'claude-opus-5-5', inputPerMTok: 4, cachedInputPerMTok: 0.2, outputPerMTok: 20 },
    { model: 'claude-opus-5', inputPerMTok: 5, cachedInputPerMTok: 0.5, outputPerMTok: 25 },
    { model: 'claude-opus-4-8', inputPerMTok: 5, cachedInputPerMTok: 0.5, outputPerMTok: 25 },
    { model: 'claude-opus-4-7', inputPerMTok: 5, cachedInputPerMTok: 0.5, outputPerMTok: 25 },
    { model: 'claude-opus-4-6', inputPerMTok: 5, cachedInputPerMTok: 0.5, outputPerMTok: 25 },
    { model: 'claude-opus-4-5', inputPerMTok: 5, cachedInputPerMTok: 0.5, outputPerMTok: 25 },
    { model: 'claude-opus-4-1', inputPerMTok: 15, cachedInputPerMTok: 1.5, outputPerMTok: 75 },
    { model: 'claude-opus-4', inputPerMTok: 15, cachedInputPerMTok: 1.5, outputPerMTok: 75 },
    { model: 'claude-sonnet-5-5', inputPerMTok: 2, cachedInputPerMTok: 0.1, outputPerMTok: 10 },
    { model: 'claude-sonnet-5', inputPerMTok: 2, cachedInputPerMTok: 0.2, outputPerMTok: 10 },
    { model: 'claude-sonnet-4-6', inputPerMTok: 3, cachedInputPerMTok: 0.3, outputPerMTok: 15 },
    { model: 'claude-sonnet-4-5', inputPerMTok: 3, cachedInputPerMTok: 0.3, outputPerMTok: 15 },
    { model: 'claude-sonnet-4', inputPerMTok: 3, cachedInputPerMTok: 0.3, outputPerMTok: 15 },
    {
      model: 'claude-haiku-5-5',
      inputPerMTok: 0.1,
      cachedInputPerMTok: 0.01,
      outputPerMTok: 0.5,
      longContext: { aboveInputTokens: 100_000, inputPerMTok: 0.5, cachedInputPerMTok: 0.05, outputPerMTok: 2.5 },
    },
    { model: 'claude-haiku-4-5', inputPerMTok: 1, cachedInputPerMTok: 0.1, outputPerMTok: 5 },
    { model: 'claude-3-5-haiku', inputPerMTok: 0.8, cachedInputPerMTok: 0.08, outputPerMTok: 4 },
  ],
};

export const anthropicPricing = priceListPricing(ANTHROPIC_PRICE_LIST);
