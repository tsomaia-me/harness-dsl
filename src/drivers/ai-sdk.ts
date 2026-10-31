import { randomUUID } from 'node:crypto';
import { APICallError, generateText, jsonSchema, type LanguageModel, Output, RetryError } from 'ai';
import { anthropicPreset } from '../presets/anthropic.js';
import { googlePreset } from '../presets/google.js';
import { openaiPreset } from '../presets/openai.js';
import { RateLimitedError } from '../quota.js';
import { ietfRateLimits } from '../rate-limits/ietf.js';
import type {
  BatchAdapter,
  Driver,
  DriverInvokeRequest,
  DriverInvokeResult,
  PricingAdapter,
  RateLimitAdapter,
  TokenUsage,
} from '../types.js';

export type SdkProviderName = 'anthropic' | 'google' | 'openai';

export type ProviderOptions = NonNullable<Parameters<typeof generateText>[0]['providerOptions']>;

export interface ProviderConnection {
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly fetch?: typeof fetch;
}

export interface ProviderPreset {
  readonly name: string;
  readonly apiKeyEnv?: string;
  createModel(modelId: string, connection: ProviderConnection): LanguageModel;
  mapModelOptions?(options: Record<string, unknown>): ProviderOptions | undefined;
  readonly rateLimits?: RateLimitAdapter;
  readonly pricing?: PricingAdapter;
  createBatch?(connection: Omit<ProviderConnection, 'apiKey'> & { readonly apiKey: () => string }): BatchAdapter;
}

const FIRST_PARTY_PRESETS: Readonly<Record<SdkProviderName, ProviderPreset>> = {
  anthropic: anthropicPreset,
  google: googlePreset,
  openai: openaiPreset,
};

const UNPRICED: PricingAdapter = { estimate: () => null };

export interface AiSdkDriverOptions {
  readonly provider: SdkProviderName | ProviderPreset;
  readonly apiKeyEnv?: string;
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly customFetch?: typeof fetch;
  readonly rateLimits?: RateLimitAdapter;
  readonly pricing?: PricingAdapter;
  readonly batch?: BatchAdapter | false;
}

export class AiSdkDriver implements Driver {
  public readonly kind = 'ai-sdk';
  public readonly preset: ProviderPreset;
  private readonly apiKeyEnv?: string;
  private readonly explicitApiKey?: string;
  private readonly baseURL?: string;
  private readonly customFetch?: typeof fetch;
  private readonly rateLimits: RateLimitAdapter;
  private readonly pricing: PricingAdapter;
  public readonly batch?: BatchAdapter;

  public constructor(opts: AiSdkDriverOptions) {
    this.preset = typeof opts.provider === 'string' ? FIRST_PARTY_PRESETS[opts.provider] : opts.provider;
    this.apiKeyEnv = opts.apiKeyEnv ?? this.preset.apiKeyEnv;
    this.explicitApiKey = opts.apiKey;
    this.baseURL = opts.baseURL;
    this.customFetch = opts.customFetch;
    this.rateLimits = opts.rateLimits ?? this.preset.rateLimits ?? ietfRateLimits;
    this.pricing = opts.pricing ?? this.preset.pricing ?? UNPRICED;
    this.batch =
      opts.batch === false
        ? undefined
        : (opts.batch ??
          this.preset.createBatch?.({
            apiKey: () => this.requireApiKey(),
            baseURL: this.baseURL,
            fetch: this.customFetch,
          }));
  }

  private requireApiKey(): string {
    const apiKey = this.explicitApiKey ?? (this.apiKeyEnv ? process.env[this.apiKeyEnv] : undefined);
    if (!apiKey) {
      throw new Error(
        `Missing API key in environment variable ${this.apiKeyEnv ?? '(none configured)'} for ${this.preset.name}`,
      );
    }
    return apiKey;
  }

  private connection(): ProviderConnection {
    return {
      apiKey: this.explicitApiKey || this.apiKeyEnv ? this.requireApiKey() : undefined,
      baseURL: this.baseURL,
      fetch: this.customFetch,
    };
  }

  public async invoke(req: DriverInvokeRequest): Promise<DriverInvokeResult> {
    const model = this.preset.createModel(req.modelId, this.connection());
    const providerOptions = this.preset.mapModelOptions?.(req.modelOptions);

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
      const cost = (req.pricing ?? this.pricing).estimate(
        req.modelId,
        { inputTokens, cachedInputTokens, outputTokens },
        Date.now(),
      );

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
}
