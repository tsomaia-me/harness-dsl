import type { QuotaWindowPatch, RateLimitAdapter } from '../types.js';
import { lowercaseHeaders, numericHeader, quotaPatch, remainingWindow, retryAfterCooldown } from './headers.js';

export const ANTHROPIC_5H_WINDOW = 'anthropic:5h';
export const ANTHROPIC_7D_WINDOW = 'anthropic:7d';

const UNIFIED_WINDOWS = [
  { span: '5h', id: ANTHROPIC_5H_WINDOW },
  { span: '7d', id: ANTHROPIC_7D_WINDOW },
] as const;
const LIMIT_KINDS = ['requests', 'tokens', 'input-tokens', 'output-tokens'] as const;

export const anthropicRateLimits: RateLimitAdapter = {
  fromResponse(response, nowMs) {
    const headers = lowercaseHeaders(response.headers);
    const unified = UNIFIED_WINDOWS.map(({ span, id }): QuotaWindowPatch | null => {
      const utilization = numericHeader(headers, `anthropic-ratelimit-unified-${span}-utilization`);
      const resetSeconds = numericHeader(headers, `anthropic-ratelimit-unified-${span}-reset`);
      if (utilization === undefined && resetSeconds === undefined) return null;
      return {
        id,
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
