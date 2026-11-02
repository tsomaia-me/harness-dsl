import { openrouterBatchAdapter } from '../batch/openrouter.js';
import type { ProviderPreset } from '../drivers/ai-sdk.js';
import { anthropicPricing } from '../pricing/anthropic.js';
import { googlePricing } from '../pricing/google.js';
import { openaiPricing } from '../pricing/openai.js';
import { ietfRateLimits } from '../rate-limits/ietf.js';
import { openaiRateLimits } from '../rate-limits/openai.js';
import { composeRateLimits } from '../rate-limits/compose.js';
import type { PricingAdapter } from '../types.js';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** OpenRouter ids are `<vendor>/<model>`; the first vendor list that knows the model prices it. */
export const openrouterPricing: PricingAdapter = {
  estimate(modelId, usage, atMs) {
    for (const pricing of [openaiPricing, anthropicPricing, googlePricing]) {
      const estimate = pricing.estimate(modelId, usage, atMs);
      if (estimate !== null) return estimate;
    }
    return null;
  },
};

/** OpenRouter through the OpenAI-compatible API, with its batch endpoint. */
export const openrouterPreset: ProviderPreset = {
  name: 'openrouter',
  apiKeyEnv: 'OPEN_ROUTER_API_KEY',
  createModel: async (modelId, connection) => (await import('@ai-sdk/openai')).createOpenAI({ ...connection, baseURL: connection.baseURL ?? OPENROUTER_BASE_URL })(modelId),
  mapModelOptions: ({ cachePrefix: _cachePrefix, thinkingBudget: _thinkingBudget, effort, ...rest }) => {
    const openai = { ...rest, ...(typeof effort === 'string' ? { reasoningEffort: effort } : {}) };
    return Object.keys(openai).length > 0 ? { openai } : undefined;
  },
  rateLimits: composeRateLimits(ietfRateLimits, openaiRateLimits),
  pricing: openrouterPricing,
  createBatch: (connection) =>
    openrouterBatchAdapter({
      apiKey: connection.apiKey,
      baseURL: connection.baseURL ?? OPENROUTER_BASE_URL,
      fetch: connection.fetch,
      pricing: connection.pricing,
    }),
};
