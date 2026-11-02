import type { BatchAdapter, BatchItemResult, PricingAdapter } from '../types.js';

export interface OpenRouterBatchOptions {
  readonly apiKey: () => string;
  readonly pricing: PricingAdapter;
  readonly baseURL?: string;
  readonly fetch?: typeof fetch;
}

export const OPENROUTER_BATCH_DEFAULTS = {
  baseURL: 'https://openrouter.ai/api/v1',
  completionWindow: '24h',
} as const;

const FINISHED = new Set(['completed']);
const FAILED = new Set(['failed', 'expired', 'cancelled']);

function parseContent(content: unknown): unknown {
  if (typeof content !== 'string') return undefined;
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

function round(usd: number): number {
  return Number(usd.toFixed(6));
}

/**
 * OpenRouter's batch API: inline chat-completion requests, polled by id, results inline when complete.
 * The batch reports one `usage.cost` for all of its items; each item is charged its share by tokens.
 * The list price stays the equivalent. Without a reported cost, the list price is the charge.
 */
export function openrouterBatchAdapter(opts: OpenRouterBatchOptions): BatchAdapter {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const base = (opts.baseURL ?? OPENROUTER_BATCH_DEFAULTS.baseURL).replace(/\/$/, '');
  const headers = () => ({ authorization: `Bearer ${opts.apiKey()}`, 'content-type': 'application/json' });
  const pricingByBatch = new Map<string, PricingAdapter>();

  return {
    submit: async (items, modelId, modelOptions, pricing) => {
      const requests = items.map((item) => ({
        custom_id: item.customId,
        body: {
          model: modelId,
          messages: [
            { role: 'system', content: item.systemPrompt },
            { role: 'user', content: item.userPrompt },
          ],
          response_format: { type: 'json_schema', json_schema: { name: 'output', schema: item.outputJsonSchema, strict: true } },
          ...(typeof modelOptions.effort === 'string' ? { reasoning: { effort: modelOptions.effort } } : {}),
        },
      }));
      const res = await fetchFn(`${base}/batches`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ endpoint: '/v1/chat/completions', model: modelId, completion_window: OPENROUTER_BATCH_DEFAULTS.completionWindow, requests }),
      });
      if (!res.ok) throw new Error(`OpenRouter batch submit failed (${res.status}): ${await res.text()}`);
      const data = (await res.json()) as { id: string };
      if (pricing) pricingByBatch.set(data.id, pricing);
      return { batchId: data.id };
    },

    poll: async (batchId) => {
      const res = await fetchFn(`${base}/batches/${batchId}`, { headers: headers() });
      if (!res.ok) throw new Error(`OpenRouter batch poll failed (${res.status})`);
      const data = (await res.json()) as { status: string; usage?: { cost?: number }; results?: readonly Record<string, any>[] | null };
      if (FAILED.has(data.status)) return { status: 'failed' };
      if (!FINISHED.has(data.status) || !data.results) return { status: 'running' };
      const pricing = pricingByBatch.get(batchId) ?? opts.pricing;
      pricingByBatch.delete(batchId);
      const entries = data.results.map((entry) => {
        const body = entry.response?.body as Record<string, any> | undefined;
        const usage = body?.usage ?? {};
        const cachedInputTokens = Number(usage.prompt_tokens_details?.cached_tokens ?? 0);
        const counts = { inputTokens: Number(usage.prompt_tokens ?? 0), cachedInputTokens, cacheWriteTokens: 0, outputTokens: Number(usage.completion_tokens ?? 0) };
        const ok = entry.error == null && body !== undefined;
        return { entry, body, counts, ok, tokens: ok ? counts.inputTokens + counts.outputTokens : 0 };
      });
      const reportedCost = typeof data.usage?.cost === 'number' ? data.usage.cost : undefined;
      const chargedTokens = entries.reduce((sum, item) => sum + item.tokens, 0);
      const results: BatchItemResult[] = entries.map(({ entry, body, counts, ok, tokens }) => {
        const listPrice = ok ? pricing.estimate(String(body?.model ?? ''), counts, Date.now()) : 0;
        const charged = !ok ? 0 : reportedCost !== undefined ? round(chargedTokens === 0 ? 0 : (reportedCost * tokens) / chargedTokens) : listPrice;
        return {
          customId: String(entry.custom_id),
          ok,
          structuredOutput: ok ? parseContent(body?.choices?.[0]?.message?.content) : undefined,
          error: ok ? undefined : `${entry.error?.type ?? 'error'}: ${entry.error?.message ?? 'Batch item failed'}`,
          usage: { ...counts, actualCostUsd: charged, equivalentCostUsd: listPrice },
        };
      });
      return { status: 'completed', results };
    },
  };
}
