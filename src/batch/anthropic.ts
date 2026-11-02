import type { BatchAdapter, BatchItemResult, PricingAdapter } from '../types.js';
import { fetchForPoll } from './transport.js';

export interface AnthropicBatchOptions {
  readonly apiKey: () => string;
  readonly pricing: PricingAdapter;
  readonly baseURL?: string;
  readonly fetch?: typeof fetch;
  readonly maxTokens?: number;
  readonly apiVersion?: string;
  readonly discount?: number;
  readonly structuredOutput?: 'output-format' | 'forced-tool';
}

const STRUCTURED_OUTPUT_TOOL = 'structured_output';

export const ANTHROPIC_BATCH_DEFAULTS = {
  baseURL: 'https://api.anthropic.com/v1',
  maxTokens: 16_000,
  apiVersion: '2023-06-01',
  discount: 0.5,
  structuredOutput: 'output-format',
} as const;

function outputConfig(
  outputJsonSchema: Record<string, unknown>,
  modelOptions: Record<string, unknown>,
  structuredOutput: 'output-format' | 'forced-tool',
): Record<string, unknown> | undefined {
  const config = {
    ...(structuredOutput === 'output-format'
      ? { format: { type: 'json_schema', schema: outputJsonSchema } }
      : {}),
    ...(typeof modelOptions.effort === 'string' ? { effort: modelOptions.effort } : {}),
  };
  return Object.keys(config).length > 0 ? config : undefined;
}

function parseStructuredOutput(
  content: unknown,
  structuredOutput: 'output-format' | 'forced-tool',
): unknown {
  if (!Array.isArray(content)) return undefined;
  if (structuredOutput === 'forced-tool') {
    return content.find((block) => block?.type === 'tool_use')?.input;
  }
  const text = content.find((block) => block?.type === 'text')?.text;
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function anthropicBatchAdapter(opts: AnthropicBatchOptions): BatchAdapter {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const base = (opts.baseURL ?? ANTHROPIC_BATCH_DEFAULTS.baseURL).replace(/\/$/, '');
  const apiVersion = opts.apiVersion ?? ANTHROPIC_BATCH_DEFAULTS.apiVersion;
  const discount = opts.discount ?? ANTHROPIC_BATCH_DEFAULTS.discount;
  const structuredOutput = opts.structuredOutput ?? ANTHROPIC_BATCH_DEFAULTS.structuredOutput;
  const headers = () => ({ 'x-api-key': opts.apiKey(), 'anthropic-version': apiVersion });
  const pricingByBatch = new Map<string, PricingAdapter>();

  return {
    submit: async (items, modelId, modelOptions, pricing) => {
      const requests = items.map((item) => {
        const config = outputConfig(item.outputJsonSchema, modelOptions, structuredOutput);
        return {
          custom_id: item.customId,
          params: {
            model: modelId,
            max_tokens: opts.maxTokens ?? ANTHROPIC_BATCH_DEFAULTS.maxTokens,
            system: [{ type: 'text', text: item.systemPrompt, cache_control: { type: 'ephemeral' } }],
            messages: [{ role: 'user', content: item.userPrompt }],
            ...(config ? { output_config: config } : {}),
            ...(structuredOutput === 'forced-tool'
              ? {
                  tools: [
                    {
                      name: STRUCTURED_OUTPUT_TOOL,
                      description: 'Return structured output matching the schema',
                      input_schema: item.outputJsonSchema,
                    },
                  ],
                  tool_choice: { type: 'tool', name: STRUCTURED_OUTPUT_TOOL },
                }
              : {}),
          },
        };
      });

      const res = await fetchFn(`${base}/messages/batches`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers() },
        body: JSON.stringify({ requests }),
      });
      if (!res.ok) {
        throw new Error(`Anthropic Batch submit failed (${res.status}): ${await res.text()}`);
      }
      const data = (await res.json()) as { id: string };
      if (pricing) pricingByBatch.set(data.id, pricing);
      return { batchId: data.id };
    },

    poll: async (batchId) => {
      const statusRes = await fetchForPoll(fetchFn, `${base}/messages/batches/${batchId}`, { headers: headers() });
      if (!statusRes) return { status: 'running' };
      if (!statusRes.ok) {
        throw new Error(`Anthropic Batch poll failed (${statusRes.status})`);
      }
      const statusData = (await statusRes.json()) as {
        processing_status: string;
        results_url?: string;
      };
      if (statusData.processing_status !== 'ended') {
        return { status: 'running' };
      }
      if (!statusData.results_url) {
        return { status: 'failed' };
      }

      const pricing = pricingByBatch.get(batchId) ?? opts.pricing;
      pricingByBatch.delete(batchId);
      const resultsRes = await fetchForPoll(fetchFn, statusData.results_url, { headers: headers() });
      if (!resultsRes) return { status: 'running' };
      const results: BatchItemResult[] = (await resultsRes.text())
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          const parsed = JSON.parse(line) as Record<string, any>;
          const msg = parsed.result?.message;
          const cachedInputTokens = Number(msg?.usage?.cache_read_input_tokens ?? 0);
          const cacheWriteTokens = Number(msg?.usage?.cache_creation_input_tokens ?? 0);
          const counts = {
            inputTokens: Number(msg?.usage?.input_tokens ?? 0) + cachedInputTokens + cacheWriteTokens,
            cachedInputTokens,
            cacheWriteTokens,
            outputTokens: Number(msg?.usage?.output_tokens ?? 0),
          };
          const fullCost =
            typeof msg?.model === 'string' ? pricing.estimate(msg.model, counts, Date.now()) : null;
          const succeeded = parsed.result?.type === 'succeeded';
          return {
            customId: String(parsed.custom_id),
            ok: succeeded,
            structuredOutput: parseStructuredOutput(msg?.content, structuredOutput),
            error: succeeded ? undefined : JSON.stringify(parsed.result?.error ?? 'Batch item failed'),
            usage: {
              ...counts,
              actualCostUsd: fullCost === null ? null : Number((fullCost * discount).toFixed(6)),
              equivalentCostUsd: fullCost,
            },
          };
        });

      return { status: 'completed', results };
    },

    cancel: async (batchId) => {
      await fetchFn(`${base}/messages/batches/${batchId}/cancel`, { method: 'POST', headers: headers() });
    },
  };
}
