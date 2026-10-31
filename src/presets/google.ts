import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { ProviderPreset } from '../drivers/ai-sdk.js';
import { googlePricing } from '../pricing/google.js';
import { googleRateLimits } from '../rate-limits/google.js';

export const googlePreset: ProviderPreset = {
  name: 'google',
  apiKeyEnv: 'GEMINI_API_KEY',
  createModel: (modelId, connection) => createGoogleGenerativeAI(connection)(modelId),
  mapModelOptions: ({ cachePrefix: _cachePrefix, thinkingBudget, effort: _effort, ...rest }) => {
    const google = {
      ...rest,
      ...(typeof thinkingBudget === 'number' && thinkingBudget > 0
        ? { thinkingConfig: { thinkingBudget } }
        : {}),
    };
    return Object.keys(google).length > 0 ? { google } : undefined;
  },
  rateLimits: googleRateLimits,
  pricing: googlePricing,
};
