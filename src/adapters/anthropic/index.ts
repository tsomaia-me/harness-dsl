import { AiSdkDriver } from '../../drivers/ai-sdk.js';
import type { BatchModel, ModelDriver, ModelRequest, ModelResponse } from '../../kernel/backends.js';
import type { Account, QuotaPartition } from '../../kernel/quota.js';
import type { EnvRef, Resolver } from '../../kernel/refs.js';
import type { BatchItemResult } from '../../types.js';
import { DEFAULT_RATE_LIMIT_COOLDOWN_MS, DEFAULT_UNAVAILABLE_COOLDOWN_MS, envelopeSchema, refusalOf, systemPrompt, tokensOf, unpack, userPrompt, windowsOf } from '../model-calls.js';

export const DEFAULT_INACTIVITY_TIMEOUT_MS = 10 * 60_000;

export interface AnthropicDriverOptions {
  readonly fetch?: typeof fetch;
  readonly baseURL?: string;
  readonly inactivityTimeoutMs?: number;
  readonly rateLimitCooldownMs?: number;
  readonly unavailableCooldownMs?: number;
}

function indexOf(customId: string): number {
  return Number(customId.slice(0, customId.indexOf(':')));
}

/**
 * The 0.3.0 AI SDK driver with the Anthropic preset behind the 0.4.0 `ModelDriver` contract. A batch's
 * job id carries the credential's env name so a restarted harness can still collect it.
 */
export class AnthropicDriver implements ModelDriver<'anthropic'> {
  public readonly name = 'anthropic';
  public readonly driver = 'anthropic' as const;
  public readonly hooks = false;
  private readonly inners = new Map<string, AiSdkDriver>();

  public constructor(private readonly options: AnthropicDriverOptions = {}) {}

  public serves(account: Account): boolean {
    return account.driver === 'anthropic';
  }

  private inner(credential: EnvRef, resolver: Resolver): AiSdkDriver {
    let inner = this.inners.get(credential.name);
    if (!inner) {
      inner = new AiSdkDriver({ provider: 'anthropic', apiKey: resolver.env(credential), ...(this.options.fetch ? { fetch: this.options.fetch } : {}), ...(this.options.baseURL ? { baseURL: this.options.baseURL } : {}) });
      this.inners.set(credential.name, inner);
    }
    return inner;
  }

  private cooldowns() {
    return {
      rateLimitCooldownMs: this.options.rateLimitCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS,
      unavailableCooldownMs: this.options.unavailableCooldownMs ?? DEFAULT_UNAVAILABLE_COOLDOWN_MS,
    };
  }

  public async invoke(request: ModelRequest, resolver: Resolver): Promise<ModelResponse> {
    let result;
    try {
      result = await this.inner(request.account.credential, resolver).invoke({
        accountId: request.account.name,
        modelId: request.model,
        modelOptions: {},
        systemPrompt: systemPrompt(request),
        userPrompt: userPrompt(request),
        outputJsonSchema: envelopeSchema(request),
        workDir: process.cwd(),
        runId: request.idempotencyKey,
        stepName: request.seat,
        inactivityTimeoutMs: this.options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS,
        signal: new AbortController().signal,
      });
    } catch (err) {
      throw refusalOf(err, request.account.name, Date.now(), this.cooldowns()) ?? err;
    }
    const windows = windowsOf(result.quotaHint);
    return { ...unpack(result.structuredOutput), costUsd: result.usage.actualCostUsd, tokens: tokensOf(result.usage), ...(windows.length > 0 ? { windows } : {}) };
  }

  public async submitBatch(requests: readonly ModelRequest[], resolver: Resolver): Promise<{ readonly jobId: string }> {
    const first = requests[0];
    if (!first) throw new Error('a batch needs at least one request');
    const batch = this.inner(first.account.credential, resolver).batch;
    if (!batch) throw new Error('the anthropic batch adapter is not available');
    try {
      const { batchId } = await batch.submit(
        requests.map((request, index) => ({ customId: `${index}:${request.idempotencyKey}`, systemPrompt: systemPrompt(request), userPrompt: userPrompt(request), outputJsonSchema: envelopeSchema(request) })),
        first.model,
        {},
      );
      return { jobId: `${first.account.credential.name}:${batchId}` };
    } catch (err) {
      throw refusalOf(err, first.account.name, Date.now(), this.cooldowns()) ?? err;
    }
  }

  public async collectBatch(jobId: string, resolver: Resolver): Promise<readonly ModelResponse[] | undefined> {
    const separator = jobId.indexOf(':');
    const batch = this.inner({ ref: 'env', name: jobId.slice(0, separator) }, resolver).batch;
    if (!batch) throw new Error('the anthropic batch adapter is not available');
    const polled = await batch.poll(jobId.slice(separator + 1));
    if (polled.status === 'running') return undefined;
    if (polled.status === 'failed' || !polled.results) throw new Error(`batch "${jobId}" failed`);
    const failed = polled.results.filter((item) => !item.ok);
    if (failed.length > 0) throw new Error(`batch "${jobId}" has failed items: ${failed.map((item) => `${item.customId}: ${item.error ?? 'unknown'}`).join('; ')}`);
    return [...polled.results]
      .sort((p, q) => indexOf(p.customId) - indexOf(q.customId))
      .map((item: BatchItemResult) => ({ ...unpack(item.structuredOutput), costUsd: item.usage.actualCostUsd, tokens: tokensOf(item.usage) }));
  }
}

export const anthropic = {
  /** An Anthropic API key, drawing on the named quota partition. */
  account(name: string, options: { readonly apiKey: EnvRef; readonly quota: QuotaPartition }): Account<'anthropic'> {
    return { entity: 'account', name, driver: 'anthropic', credential: options.apiKey, quota: options.quota };
  },
  model(name: string, options: { readonly id: string }): BatchModel<'anthropic'> {
    return { entity: 'model', name, id: options.id, driver: 'anthropic', batch: true };
  },
  driver(options?: AnthropicDriverOptions): AnthropicDriver {
    return new AnthropicDriver(options);
  },
};
