import type { BatchAdapter, BatchItemResult, PricingAdapter } from '../types.js';

export interface OpenRouterBatchOptions {
  readonly apiKey: () => string;
  readonly pricing: PricingAdapter;
  readonly baseURL?: string;
  readonly fetch?: typeof fetch;
  /** The share of the standard price a batch request costs; OpenRouter's typical rate is 0.5. */
  readonly discount?: number;
}

export const OPENROUTER_BATCH_DEFAULTS = {
  baseURL: 'https://openrouter.ai/api/v1',
  discount: 0.5,
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

/** OpenRouter's batch API: inline chat-completion requests, polled by id, results inline when complete. */
export function openrouterBatchAdapter(opts: OpenRouterBatchOptions): BatchAdapter {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const base = (opts.baseURL ?? OPENROUTER_BATCH_DEFAULTS.baseURL).replace(/\/$/, '');
  const discount = opts.discount ?? OPENROUTER_BATCH_DEFAULTS.discount;
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
      const data = (await res.json()) as { status: string; results?: readonly Record<string, any>[] | null };
      if (FAILED.has(data.status)) return { status: 'failed' };
      if (!FINISHED.has(data.status) || !data.results) return { status: 'running' };
      const pricing = pricingByBatch.get(batchId) ?? opts.pricing;
      pricingByBatch.delete(batchId);
      const results: BatchItemResult[] = data.results.map((entry) => {
        const body = entry.response?.body as Record<string, any> | undefined;
        const usage = body?.usage ?? {};
        const cachedInputTokens = Number(usage.prompt_tokens_details?.cached_tokens ?? 0);
        const counts = { inputTokens: Number(usage.prompt_tokens ?? 0), cachedInputTokens, cacheWriteTokens: 0, outputTokens: Number(usage.completion_tokens ?? 0) };
        const ok = entry.error == null && body !== undefined;
        const fullCost = ok && typeof body?.model === 'string' ? pricing.estimate(body.model, counts, Date.now()) : ok ? pricing.estimate(String(entry.response?.body?.model ?? ''), counts, Date.now()) : 0;
        return {
          customId: String(entry.custom_id),
          ok,
          structuredOutput: ok ? parseContent(body?.choices?.[0]?.message?.content) : undefined,
          error: ok ? undefined : `${entry.error?.type ?? 'error'}: ${entry.error?.message ?? 'Batch item failed'}`,
          usage: { ...counts, actualCostUsd: fullCost === null ? null : Number((fullCost * discount).toFixed(6)), equivalentCostUsd: fullCost },
        };
      });
      return { status: 'completed', results };
    },
  };
}
