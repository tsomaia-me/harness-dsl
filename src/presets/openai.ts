import { createOpenAI } from '@ai-sdk/openai';
import type { ProviderPreset } from '../drivers/ai-sdk.js';
import { openaiPricing } from '../pricing/openai.js';
import { openaiRateLimits } from '../rate-limits/openai.js';

export const openaiPreset: ProviderPreset = {
  name: 'openai',
  apiKeyEnv: 'OPENAI_API_KEY',
  createModel: (modelId, connection) => createOpenAI(connection)(modelId),
  mapModelOptions: ({ cachePrefix: _cachePrefix, thinkingBudget: _thinkingBudget, effort, ...rest }) => {
    const openai = { ...rest, ...(typeof effort === 'string' ? { reasoningEffort: effort } : {}) };
    return Object.keys(openai).length > 0 ? { openai } : undefined;
  },
  rateLimits: openaiRateLimits,
  pricing: openaiPricing,
};
