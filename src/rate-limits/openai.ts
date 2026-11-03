import type { RateLimitAdapter } from '../types.js';
import { lowercaseHeaders, numericHeader, quotaPatch, remainingWindow, retryAfterCooldown } from './headers.js';

const DURATION_UNIT_MS: Readonly<Record<string, number>> = { h: 3_600_000, m: 60_000, s: 1_000, ms: 1 };

export function parseOpenAiDurationMs(duration: string): number | undefined {
  const parts = [...duration.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)];
  if (parts.length === 0 || parts.map((p) => p[0]).join('') !== duration.trim()) return undefined;
  return parts.reduce((total, [, amount, unit]) => total + Number(amount) * DURATION_UNIT_MS[unit!]!, 0);
}

export const openaiRateLimits: RateLimitAdapter = {
  fromResponse(response, nowMs) {
    const headers = lowercaseHeaders(response.headers);
    const windows = (['requests', 'tokens'] as const).map((kind) => {
      const reset = headers[`x-ratelimit-reset-${kind}`];
      const resetMs = reset !== undefined ? parseOpenAiDurationMs(reset) : undefined;
      return remainingWindow(
        `openai:${kind}`,
        numericHeader(headers, `x-ratelimit-limit-${kind}`),
        numericHeader(headers, `x-ratelimit-remaining-${kind}`),
        resetMs !== undefined ? nowMs + resetMs : undefined,
      );
    });
    const retryAfterMs = numericHeader(headers, 'retry-after-ms');
    return quotaPatch(
      windows,
      retryAfterMs !== undefined ? nowMs + retryAfterMs : retryAfterCooldown(headers, nowMs),
    );
  },
};
