import type { RateLimitAdapter } from '../types.js';
import { composeRateLimits } from './compose.js';
import { quotaPatch } from './headers.js';
import { ietfRateLimits } from './ietf.js';

const RETRY_INFO_TYPE = 'type.googleapis.com/google.rpc.RetryInfo';

function retryDelayMs(body: unknown): number | undefined {
  const details = (body as { error?: { details?: unknown } } | undefined)?.error?.details;
  if (!Array.isArray(details)) return undefined;
  const retryInfo = details.find((detail) => detail?.['@type'] === RETRY_INFO_TYPE);
  const match = typeof retryInfo?.retryDelay === 'string' ? /^(\d+(?:\.\d+)?)s$/.exec(retryInfo.retryDelay) : null;
  return match ? Number(match[1]) * 1000 : undefined;
}

const googleRetryInfo: RateLimitAdapter = {
  fromResponse(response, nowMs) {
    const delayMs = retryDelayMs(response.body);
    return quotaPatch([], delayMs !== undefined ? nowMs + delayMs : undefined);
  },
};

export const googleRateLimits = composeRateLimits(ietfRateLimits, googleRetryInfo);
