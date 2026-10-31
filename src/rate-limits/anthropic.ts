import type { QuotaWindowPatch, RateLimitAdapter } from '../types.js';
import { lowercaseHeaders, numericHeader, quotaPatch, remainingWindow, retryAfterCooldown } from './headers.js';

const UNIFIED_SPANS = ['5h', '7d'] as const;
const LIMIT_KINDS = ['requests', 'tokens', 'input-tokens', 'output-tokens'] as const;

export const anthropicRateLimits: RateLimitAdapter = {
  fromHeaders(rawHeaders, nowMs) {
    const headers = lowercaseHeaders(rawHeaders);
    const unified = UNIFIED_SPANS.map((span): QuotaWindowPatch | null => {
      const utilization = numericHeader(headers, `anthropic-ratelimit-unified-${span}-utilization`);
      const resetSeconds = numericHeader(headers, `anthropic-ratelimit-unified-${span}-reset`);
      if (utilization === undefined && resetSeconds === undefined) return null;
      return {
        id: `anthropic:${span}`,
        ...(utilization !== undefined ? { utilization } : {}),
        ...(resetSeconds !== undefined ? { resetsAtMs: resetSeconds * 1000 } : {}),
      };
    });
    const limits = LIMIT_KINDS.map((kind) => {
      const reset = headers[`anthropic-ratelimit-${kind}-reset`];
      const resetsAtMs = reset !== undefined ? Date.parse(reset) : Number.NaN;
      return remainingWindow(
        `anthropic:${kind}`,
        numericHeader(headers, `anthropic-ratelimit-${kind}-limit`),
        numericHeader(headers, `anthropic-ratelimit-${kind}-remaining`),
        Number.isNaN(resetsAtMs) ? undefined : resetsAtMs,
      );
    });
    return quotaPatch([...unified, ...limits], retryAfterCooldown(headers, nowMs));
  },
};
