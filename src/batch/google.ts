import { randomUUID } from 'node:crypto';
import type { BatchAdapter, BatchItemResult, PricingAdapter } from '../types.js';
import { fetchForPoll } from './transport.js';

export interface GoogleBatchOptions {
  readonly apiKey: () => string;
  readonly pricing: PricingAdapter;
  readonly baseURL?: string;
  readonly fetch?: typeof fetch;
  /** The share of the standard price a batch request costs; Gemini's batch rate is 0.5. */
  readonly discount?: number;
}

export const GOOGLE_BATCH_DEFAULTS = {
  baseURL: 'https://generativelanguage.googleapis.com/v1beta',
  discount: 0.5,
} as const;

const FAILED_STATES = new Set(['BATCH_STATE_FAILED', 'BATCH_STATE_CANCELLED', 'BATCH_STATE_EXPIRED', 'JOB_STATE_FAILED', 'JOB_STATE_CANCELLED', 'JOB_STATE_EXPIRED']);

function parseText(response: Record<string, any> | undefined): unknown {
  const text = response?.candidates?.[0]?.content?.parts?.find((part: { text?: unknown }) => typeof part.text === 'string')?.text;
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Gemini batch mode with inline requests: one long-running operation per batch, polled until done, responses inline. */
export function googleBatchAdapter(opts: GoogleBatchOptions): BatchAdapter {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const base = (opts.baseURL ?? GOOGLE_BATCH_DEFAULTS.baseURL).replace(/\/$/, '');
  const discount = opts.discount ?? GOOGLE_BATCH_DEFAULTS.discount;
  const headers = () => ({ 'x-goog-api-key': opts.apiKey(), 'content-type': 'application/json' });
  const pricingByBatch = new Map<string, PricingAdapter>();
  const orderByBatch = new Map<string, readonly string[]>();

  return {
    submit: async (items, modelId, modelOptions, pricing) => {
      const requests = items.map((item) => ({
        request: {
          system_instruction: { parts: [{ text: item.systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: item.userPrompt }] }],
          generation_config: {
            response_mime_type: 'application/json',
            response_json_schema: item.outputJsonSchema,
            ...(typeof modelOptions.thinkingBudget === 'number' ? { thinking_config: { thinking_budget: modelOptions.thinkingBudget } } : {}),
          },
        },
        metadata: { key: item.customId },
      }));
      const res = await fetchFn(`${base}/models/${modelId}:batchGenerateContent`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ batch: { display_name: `harness-${randomUUID()}`, input_config: { requests: { requests } } } }),
      });
      if (!res.ok) throw new Error(`Gemini batch submit failed (${res.status}): ${await res.text()}`);
      const data = (await res.json()) as { name: string };
      if (pricing) pricingByBatch.set(data.name, pricing);
      orderByBatch.set(
        data.name,
        items.map((item) => item.customId),
      );
      return { batchId: data.name };
    },

    poll: async (batchId) => {
      const res = await fetchForPoll(fetchFn, `${base}/${batchId}`, { headers: headers() });
      if (!res) return { status: 'running' };
      if (!res.ok) throw new Error(`Gemini batch poll failed (${res.status})`);
      const data = (await res.json()) as { done?: boolean; error?: unknown; metadata?: { state?: string }; state?: string; response?: Record<string, any> };
      const state = data.metadata?.state ?? data.state ?? '';
      if (FAILED_STATES.has(state) || (data.done && data.error && !data.response)) return { status: 'failed' };
      if (!data.done || !data.response) return { status: 'running' };
      const inlined = (data.response.inlinedResponses?.inlinedResponses ?? data.response.inlinedResponses ?? []) as readonly Record<string, any>[];
      const pricing = pricingByBatch.get(batchId) ?? opts.pricing;
      const order = orderByBatch.get(batchId);
      pricingByBatch.delete(batchId);
      orderByBatch.delete(batchId);
      const results: BatchItemResult[] = inlined.map((entry, index) => {
        const response = entry.response as Record<string, any> | undefined;
        const usage = response?.usageMetadata ?? {};
        const counts = {
          inputTokens: Number(usage.promptTokenCount ?? 0),
          cachedInputTokens: Number(usage.cachedContentTokenCount ?? 0),
          cacheWriteTokens: 0,
          outputTokens: Number(usage.candidatesTokenCount ?? 0),
        };
        const ok = entry.error == null && response !== undefined;
        const fullCost = ok ? pricing.estimate(typeof response?.modelVersion === 'string' ? response.modelVersion : batchId, counts, Date.now()) : 0;
        return {
          customId: String(entry.metadata?.key ?? order?.[index] ?? index),
          ok,
          structuredOutput: ok ? parseText(response) : undefined,
          error: ok ? undefined : `${entry.error?.code ?? 'error'}: ${entry.error?.message ?? 'Batch item failed'}`,
          usage: { ...counts, actualCostUsd: fullCost === null ? null : Number((fullCost * discount).toFixed(6)), equivalentCostUsd: fullCost },
        };
      });
      return { status: 'completed', results };
    },

    cancel: async (batchId) => {
      await fetchFn(`${base}/${batchId}:cancel`, { method: 'POST', headers: headers() });
    },
  };
}
