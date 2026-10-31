import type { QuotaWindowPatch, RateLimitAdapter } from '../types.js';
import { quotaPatch } from './headers.js';

export function composeRateLimits(...adapters: readonly RateLimitAdapter[]): RateLimitAdapter {
  return {
    fromResponse(response, nowMs) {
      const windowsById = new Map<string, QuotaWindowPatch>();
      let cooldownUntilMs: number | undefined;
      for (const adapter of adapters) {
        const patch = adapter.fromResponse(response, nowMs);
        for (const window of patch.windows ?? []) windowsById.set(window.id, window);
        if (typeof patch.cooldownUntilMs === 'number') {
          cooldownUntilMs = Math.max(cooldownUntilMs ?? patch.cooldownUntilMs, patch.cooldownUntilMs);
        }
      }
      return quotaPatch([...windowsById.values()], cooldownUntilMs);
    },
  };
}
