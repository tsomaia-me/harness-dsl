import type { PricingAdapter, TokenCounts } from '../types.js';

export interface TokenRates {
  readonly inputPerMTok: number;
  readonly cachedInputPerMTok?: number;
  readonly outputPerMTok: number;
}

export interface ModelPrice extends TokenRates {
  readonly model: string;
  readonly effectiveFrom?: string;
  readonly longContext?: TokenRates & { readonly aboveInputTokens: number };
}

export interface PriceList {
  readonly source: string;
  readonly asOf: string;
  readonly prices: readonly ModelPrice[];
}

const ID_SEPARATORS = new Set(['.', '/']);
const SUFFIX_SEPARATORS = new Set(['-', '@', ':']);

function matchesModel(modelId: string, model: string): boolean {
  for (let start = 0; start <= modelId.length - model.length; start += 1) {
    const atIdStart = start === 0 || ID_SEPARATORS.has(modelId[start - 1]!);
    if (!atIdStart || !modelId.startsWith(model, start)) continue;
    const next = modelId[start + model.length];
    if (next === undefined || SUFFIX_SEPARATORS.has(next)) return true;
  }
  return false;
}

function costUsd(rates: TokenRates, usage: TokenCounts): number {
  const cachedRate = rates.cachedInputPerMTok ?? rates.inputPerMTok;
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const total =
    uncachedInput * rates.inputPerMTok +
    usage.cachedInputTokens * cachedRate +
    usage.outputTokens * rates.outputPerMTok;
  return Number((total / 1_000_000).toFixed(6));
}

export function priceListPricing(list: PriceList): PricingAdapter {
  return {
    estimate(modelId, usage, atMs) {
      const normalizedId = modelId.toLowerCase();
      const inEffect = list.prices.filter(
        (price) =>
          matchesModel(normalizedId, price.model) &&
          (price.effectiveFrom === undefined || Date.parse(price.effectiveFrom) <= atMs),
      );
      const best = inEffect.sort(
        (a, b) =>
          b.model.length - a.model.length ||
          Date.parse(b.effectiveFrom ?? '1970-01-01') - Date.parse(a.effectiveFrom ?? '1970-01-01'),
      )[0];
      if (!best) return null;
      const rates =
        best.longContext && usage.inputTokens > best.longContext.aboveInputTokens
          ? best.longContext
          : best;
      return costUsd(rates, usage);
    },
  };
}
