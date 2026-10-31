import type { RateLimitAdapter } from '../types.js';
import { lowercaseHeaders, numericHeader, quotaPatch, remainingWindow, retryAfterCooldown } from './headers.js';

export const ietfRateLimits: RateLimitAdapter = {
  fromHeaders(rawHeaders, nowMs) {
    const headers = lowercaseHeaders(rawHeaders);
    const resetSeconds = numericHeader(headers, 'ratelimit-reset');
    return quotaPatch(
      [
        remainingWindow(
          'http:ratelimit',
          numericHeader(headers, 'ratelimit-limit'),
          numericHeader(headers, 'ratelimit-remaining'),
          resetSeconds !== undefined ? nowMs + resetSeconds * 1000 : undefined,
        ),
      ],
      retryAfterCooldown(headers, nowMs),
    );
  },
};
