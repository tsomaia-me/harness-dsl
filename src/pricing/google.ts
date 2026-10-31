import { type PriceList, priceListPricing } from './table.js';

export const GOOGLE_PRICE_LIST: PriceList = {
  source: 'https://ai.google.dev/gemini-api/docs/pricing',
  asOf: '2026-10-31',
  prices: [
    { model: 'gemini-4-argon', inputPerMTok: 2, cachedInputPerMTok: 0.1, outputPerMTok: 10 },
    {
      model: 'gemini-4-argon',
      effectiveFrom: '2026-12-01T00:00:00Z',
      inputPerMTok: 4,
      cachedInputPerMTok: 0.2,
      outputPerMTok: 20,
    },
    { model: 'gemini-3.8-flash', inputPerMTok: 0.75, cachedInputPerMTok: 0.075, outputPerMTok: 3.75 },
    {
      model: 'gemini-3.8-flash',
      effectiveFrom: '2027-01-01T00:00:00Z',
      inputPerMTok: 1.5,
      cachedInputPerMTok: 0.15,
      outputPerMTok: 7.5,
    },
    { model: 'gemini-3.6-flash', inputPerMTok: 0.75, cachedInputPerMTok: 0.075, outputPerMTok: 3.75 },
    {
      model: 'gemini-3.6-flash',
      effectiveFrom: '2027-01-01T00:00:00Z',
      inputPerMTok: 1.5,
      cachedInputPerMTok: 0.15,
      outputPerMTok: 7.5,
    },
    { model: 'gemini-3.5-flash-lite', inputPerMTok: 0.3, cachedInputPerMTok: 0.03, outputPerMTok: 2.5 },
    { model: 'gemini-3.1-flash-lite', inputPerMTok: 0.25, cachedInputPerMTok: 0.025, outputPerMTok: 1.5 },
    {
      model: 'gemini-3.1-pro-preview',
      inputPerMTok: 2,
      cachedInputPerMTok: 0.2,
      outputPerMTok: 12,
      longContext: { aboveInputTokens: 200_000, inputPerMTok: 4, cachedInputPerMTok: 0.4, outputPerMTok: 18 },
    },
    { model: 'gemini-3-flash-preview', inputPerMTok: 0.5, cachedInputPerMTok: 0.05, outputPerMTok: 3 },
    {
      model: 'gemini-2.5-pro',
      inputPerMTok: 1.25,
      cachedInputPerMTok: 0.125,
      outputPerMTok: 10,
      longContext: { aboveInputTokens: 200_000, inputPerMTok: 2.5, cachedInputPerMTok: 0.25, outputPerMTok: 15 },
    },
    { model: 'gemini-2.5-flash', inputPerMTok: 0.3, cachedInputPerMTok: 0.03, outputPerMTok: 2.5 },
    { model: 'gemini-2.5-flash-lite', inputPerMTok: 0.1, cachedInputPerMTok: 0.01, outputPerMTok: 0.4 },
  ],
};

export const googlePricing = priceListPricing(GOOGLE_PRICE_LIST);
