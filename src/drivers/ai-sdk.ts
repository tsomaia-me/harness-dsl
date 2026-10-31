import { randomUUID } from 'node:crypto';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { APICallError, generateText, jsonSchema, Output, RetryError } from 'ai';
import { RateLimitedError } from '../quota.js';
import { anthropicRateLimits, ietfRateLimits, openaiRateLimits } from '../rate-limits/index.js';
import type {
  BatchAdapter,
  BatchItemRequest,
  BatchItemResult,
  Driver,
  DriverInvokeRequest,
  DriverInvokeResult,
  RateLimitAdapter,
  TokenUsage,
} from '../types.js';
import { estimateEquivalentUsd } from './claude-cli.js';

export type SdkProviderName = 'anthropic' | 'google' | 'openai';

const DEFAULT_RATE_LIMITS: Readonly<Record<SdkProviderName, RateLimitAdapter>> = {
  anthropic: anthropicRateLimits,
  google: ietfRateLimits,
  openai: openaiRateLimits,
};

export interface AiSdkDriverOptions {
  readonly provider: SdkProviderName;
  readonly apiKeyEnv?: string;
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly useCloudBatch?: boolean;
  readonly customFetch?: typeof fetch;
  readonly rateLimits?: RateLimitAdapter;
}

export class AiSdkDriver implements Driver {
  public readonly kind = 'ai-sdk' as const;
  public readonly provider: SdkProviderName;
  private readonly apiKeyEnv?: string;
  private readonly explicitApiKey?: string;
  private readonly baseURL?: string;
  private readonly customFetch?: typeof fetch;
  private readonly rateLimits: RateLimitAdapter;
  public readonly batch?: BatchAdapter;

  public constructor(opts: AiSdkDriverOptions) {
    this.provider = opts.provider;
    this.apiKeyEnv = opts.apiKeyEnv;
    this.explicitApiKey = opts.apiKey;
    this.baseURL = opts.baseURL;
    this.customFetch = opts.customFetch;
    this.rateLimits = opts.rateLimits ?? DEFAULT_RATE_LIMITS[opts.provider];

    const enableBatch = opts.useCloudBatch ?? true;
    if (enableBatch && opts.provider === 'anthropic') {
      this.batch = this.createAnthropicBatchAdapter();
    }
  }

  private resolveApiKey(): string {
    if (this.explicitApiKey) return this.explicitApiKey;
    const envName =
      this.apiKeyEnv ??
      (this.provider === 'anthropic'
        ? 'ANTHROPIC_API_KEY'
        : this.provider === 'google'
          ? 'GEMINI_API_KEY'
          : 'OPENAI_API_KEY');
    const val = process.env[envName];
    if (!val) {
      throw new Error(`Missing API key in environment variable ${envName} for ${this.provider}`);
    }
    return val;
  }

  private createLanguageModel(modelId: string) {
    const apiKey = this.resolveApiKey();
    switch (this.provider) {
      case 'anthropic': {
        const anthropic = createAnthropic({
          apiKey,
          baseURL: this.baseURL,
          fetch: this.customFetch,
        });
        return anthropic(modelId);
      }
      case 'google': {
        const google = createGoogleGenerativeAI({
          apiKey,
          baseURL: this.baseURL,
          fetch: this.customFetch,
        });
        return google(modelId);
      }
      case 'openai': {
        const openai = createOpenAI({
          apiKey,
          baseURL: this.baseURL,
          fetch: this.customFetch,
        });
        return openai(modelId);
      }
    }
  }

  private buildProviderOptions(modelOptions: Record<string, unknown>): Record<string, Record<string, any>> | undefined {
    const { cachePrefix, thinkingBudget, effort, ...rest } = modelOptions;
    const providerMap: Record<string, any> = { ...rest };

    if (this.provider === 'anthropic') {
      if (cachePrefix) {
        providerMap.cacheControl = { type: 'ephemeral' as const };
      }
      if (typeof thinkingBudget === 'number' && thinkingBudget > 0) {
        providerMap.thinking = { type: 'enabled' as const, budgetTokens: thinkingBudget };
      }
      if (typeof effort === 'string') {
        providerMap.effort = effort;
      }
      return Object.keys(providerMap).length > 0 ? { anthropic: providerMap } : undefined;
    }

    if (this.provider === 'openai') {
      if (typeof effort === 'string') {
        providerMap.reasoningEffort = effort;
      }
      return Object.keys(providerMap).length > 0 ? { openai: providerMap } : undefined;
    }

    if (this.provider === 'google') {
      if (typeof thinkingBudget === 'number' && thinkingBudget > 0) {
        providerMap.thinkingConfig = { thinkingBudget };
      }
      return Object.keys(providerMap).length > 0 ? { google: providerMap } : undefined;
    }

    return undefined;
  }

  public async invoke(req: DriverInvokeRequest): Promise<DriverInvokeResult> {
    const model = this.createLanguageModel(req.modelId);
    const providerOptions = this.buildProviderOptions(req.modelOptions);

    try {
      const response = await generateText({
        model,
        system: req.systemPrompt,
        prompt: req.userPrompt,
        output: Output.object({
          schema: jsonSchema(req.outputJsonSchema),
        }),
        providerOptions,
        abortSignal: req.signal,
      });

      const inputTokens = response.usage?.inputTokens ?? 0;
      const outputTokens = response.usage?.outputTokens ?? 0;
      const cachedInputTokens = (response.usage as any)?.cachedInputTokens ?? 0;
      const cost = estimateEquivalentUsd(req.modelId, inputTokens, cachedInputTokens, outputTokens);

      const rawHeaders = (response.response?.headers ?? {}) as Record<string, string | undefined>;
      const quotaHint = this.rateLimits.fromHeaders(rawHeaders, Date.now());

      const usage: TokenUsage = {
        inputTokens,
        cachedInputTokens,
        outputTokens,
        actualCostUsd: cost,
        equivalentCostUsd: cost,
      };

      return {
        structuredOutput: response.output,
        rawText: response.text || JSON.stringify(response.output),
        sessionId: req.sessionId ?? randomUUID(),
        usage,
        quotaHint: Object.keys(quotaHint).length > 0 ? quotaHint : undefined,
      };
    } catch (err) {
      const apiError = RetryError.isInstance(err) ? err.lastError : err;
      if (APICallError.isInstance(apiError) && apiError.statusCode === 429) {
        throw new RateLimitedError(
          req.accountId,
          `AI SDK rate limit on account ${req.accountId}: ${apiError.message}`,
          this.rateLimits.fromHeaders(apiError.responseHeaders ?? {}, Date.now()),
        );
      }
      throw err;
    }
  }

  private createAnthropicBatchAdapter(): BatchAdapter {
    const fetchFn = this.customFetch ?? globalThis.fetch;
    const base = (this.baseURL ?? 'https://api.anthropic.com/v1').replace(/\/$/, '');

    return {
      submit: async (items: readonly BatchItemRequest[], modelId: string) => {
        const apiKey = this.resolveApiKey();
        const requests = items.map((item) => ({
          custom_id: item.customId,
          params: {
            model: modelId,
            max_tokens: 4096,
            system: [
              {
                type: 'text',
                text: item.systemPrompt,
                cache_control: { type: 'ephemeral' },
              },
            ],
            messages: [{ role: 'user', content: item.userPrompt }],
            tools: [
              {
                name: 'structured_output',
                description: 'Return structured output matching the schema',
                input_schema: item.outputJsonSchema,
              },
            ],
            tool_choice: { type: 'tool', name: 'structured_output' },
          },
        }));

        const res = await fetchFn(`${base}/messages/batches`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({ requests }),
        });

        if (!res.ok) {
          throw new Error(`Anthropic Batch submit failed (${res.status}): ${await res.text()}`);
        }
        const data = (await res.json()) as { id: string };
        return { batchId: data.id };
      },

      poll: async (batchId: string) => {
        const apiKey = this.resolveApiKey();
        const statusRes = await fetchFn(`${base}/messages/batches/${batchId}`, {
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
        });
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

        const resultsRes = await fetchFn(statusData.results_url, {
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
        });
        const text = await resultsRes.text();
        const results: BatchItemResult[] = text
          .split('\n')
          .filter((l) => l.trim().length > 0)
          .map((line) => {
            const parsed = JSON.parse(line) as Record<string, any>;
            const msg = parsed.result?.message;
            const toolBlock = Array.isArray(msg?.content)
              ? msg.content.find((b: any) => b.type === 'tool_use')
              : undefined;
            const inTok = Number(msg?.usage?.input_tokens ?? 0);
            const cacheTok = Number(msg?.usage?.cache_read_input_tokens ?? 0);
            const outTok = Number(msg?.usage?.output_tokens ?? 0);
            const fullCost = estimateEquivalentUsd(
              msg?.model ?? 'claude-sonnet-4-6',
              inTok,
              cacheTok,
              outTok,
            );
            return {
              customId: String(parsed.custom_id),
              ok: parsed.result?.type === 'succeeded',
              structuredOutput: toolBlock?.input,
              error:
                parsed.result?.type !== 'succeeded'
                  ? JSON.stringify(parsed.result?.error ?? 'Batch item failed')
                  : undefined,
              usage: {
                inputTokens: inTok,
                cachedInputTokens: cacheTok,
                outputTokens: outTok,
                actualCostUsd: Number((fullCost * 0.5).toFixed(6)),
                equivalentCostUsd: fullCost,
              },
            };
          });

        return { status: 'completed', results };
      },

      cancel: async (batchId: string) => {
        const apiKey = this.resolveApiKey();
        await fetchFn(`${base}/messages/batches/${batchId}/cancel`, {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
        });
      },
    };
  }
}
