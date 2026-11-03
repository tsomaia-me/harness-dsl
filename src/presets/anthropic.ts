import { anthropicBatchAdapter } from '../batch/anthropic.js';
import type { ProviderPreset } from '../drivers/ai-sdk.js';
import { anthropicPricing } from '../pricing/anthropic.js';
import { anthropicRateLimits } from '../rate-limits/anthropic.js';

export const anthropicPreset: ProviderPreset = {
  name: 'anthropic',
  apiKeyEnv: 'ANTHROPIC_API_KEY',
  createModel: async (modelId, connection) => (await import('@ai-sdk/anthropic')).createAnthropic(connection)(modelId),
  mapModelOptions: ({ cachePrefix, thinkingBudget, effort, ...rest }) => {
    const anthropic = {
      ...rest,
      ...(cachePrefix ? { cacheControl: { type: 'ephemeral' } } : {}),
      ...(typeof thinkingBudget === 'number' && thinkingBudget > 0
        ? { thinking: { type: 'enabled', budgetTokens: thinkingBudget } }
        : {}),
      ...(typeof effort === 'string' ? { effort } : {}),
    };
    return Object.keys(anthropic).length > 0 ? { anthropic } : undefined;
  },
  rateLimits: anthropicRateLimits,
  pricing: anthropicPricing,
  createBatch: (connection) =>
    anthropicBatchAdapter({
      apiKey: connection.apiKey,
      baseURL: connection.baseURL,
      fetch: connection.fetch,
      pricing: connection.pricing,
    }),
};
