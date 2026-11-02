import { AiSdkDriver, type ProviderPreset, type SdkProviderName } from '../drivers/ai-sdk.js';
import type { ModelDriver, ModelRequest, ModelResponse } from '../kernel/backends.js';
import type { Account } from '../kernel/quota.js';
import type { EnvRef, Resolver } from '../kernel/refs.js';
import type { BatchItemResult } from '../types.js';
import { DEFAULT_INACTIVITY_TIMEOUT_MS, DEFAULT_RATE_LIMIT_COOLDOWN_MS, DEFAULT_UNAVAILABLE_COOLDOWN_MS, envelopeSchema, equivalentOf, refusalOf, systemPrompt, tokensOf, unpack, userPrompt, windowsOf } from './model-calls.js';

export { DEFAULT_INACTIVITY_TIMEOUT_MS };

export interface AiSdkModelDriverOptions {
  readonly fetch?: typeof fetch;
  readonly baseURL?: string;
  readonly inactivityTimeoutMs?: number;
  readonly rateLimitCooldownMs?: number;
  readonly unavailableCooldownMs?: number;
}

function indexOf(customId: string): number {
  return Number(customId.slice(0, customId.indexOf(':')));
}

/** A job id is `<credential env name>:<request count>:<batch id>`, so a restarted harness collects it and checks it whole. */
function parseJobId(jobId: string): { readonly credential: string; readonly count: number; readonly batchId: string } {
  const [credential, count, ...rest] = jobId.split(':');
  const batchId = rest.join(':');
  if (!credential || !count || !/^\d+$/.test(count) || !batchId) throw new Error(`job id "${jobId}" is not "<credential>:<count>:<batch id>"`);
  return { credential, count: Number(count), batchId };
}

/**
 * The 0.3.0 AI SDK driver with one provider preset behind the 0.4.0 `ModelDriver` contract. One inner
 * driver per credential. A batch's job id carries the credential's env name and the request count so a
 * restarted harness can collect it and check it whole; results are aligned by an index prefix on the custom id.
 */
export class AiSdkModelDriver<D extends string> implements ModelDriver<D> {
  public readonly name: string;
  public readonly hooks = false;
  private readonly inners = new Map<string, AiSdkDriver>();

  public constructor(
    public readonly driver: D,
    private readonly preset: SdkProviderName | ProviderPreset,
    private readonly options: AiSdkModelDriverOptions = {},
  ) {
    this.name = driver;
  }

  public serves(account: Account): boolean {
    return account.driver === this.driver;
  }

  private inner(credential: EnvRef | undefined, resolver: Resolver): AiSdkDriver {
    if (!credential) throw new Error(`the ${this.driver} driver needs an account with a credential`);
    let inner = this.inners.get(credential.name);
    if (!inner) {
      inner = new AiSdkDriver({ provider: this.preset, apiKey: resolver.env(credential), ...(this.options.fetch ? { fetch: this.options.fetch } : {}), ...(this.options.baseURL ? { baseURL: this.options.baseURL } : {}) });
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
        signal: request.cancel ?? new AbortController().signal,
      });
    } catch (err) {
      throw refusalOf(err, request.account.name, Date.now(), this.cooldowns()) ?? err;
    }
    const windows = windowsOf(result.quotaHint);
    return { ...unpack(result.structuredOutput), costUsd: result.usage.actualCostUsd, ...equivalentOf(result.usage), tokens: tokensOf(result.usage), ...(windows.length > 0 ? { windows } : {}) };
  }

  public async submitBatch(requests: readonly ModelRequest[], resolver: Resolver): Promise<{ readonly jobId: string }> {
    const first = requests[0];
    if (!first) throw new Error('a batch needs at least one request');
    const batch = this.inner(first.account.credential, resolver).batch;
    if (!batch) throw new Error(`the ${this.driver} driver has no batch adapter`);
    try {
      const { batchId } = await batch.submit(
        requests.map((request, index) => ({ customId: `${index}:${request.idempotencyKey}`, systemPrompt: systemPrompt(request), userPrompt: userPrompt(request), outputJsonSchema: envelopeSchema(request) })),
        first.model,
        {},
      );
      return { jobId: `${first.account.credential!.name}:${requests.length}:${batchId}` };
    } catch (err) {
      throw refusalOf(err, first.account.name, Date.now(), this.cooldowns()) ?? err;
    }
  }

  public async collectBatch(jobId: string, resolver: Resolver): Promise<readonly ModelResponse[] | undefined> {
    const { credential, count, batchId } = parseJobId(jobId);
    const batch = this.inner({ ref: 'env', name: credential }, resolver).batch;
    if (!batch) throw new Error(`the ${this.driver} driver has no batch adapter`);
    const polled = await batch.poll(batchId);
    if (polled.status === 'running') return undefined;
    if (polled.status === 'failed' || !polled.results) throw new Error(`batch "${jobId}" failed`);
    if (polled.results.length !== count) throw new Error(`batch "${jobId}" returned ${polled.results.length} results for ${count} requests`);
    const failed = polled.results.filter((item) => !item.ok);
    if (failed.length > 0) throw new Error(`batch "${jobId}" has failed items: ${failed.map((item) => `${item.customId}: ${item.error ?? 'unknown'}`).join('; ')}`);
    return [...polled.results]
      .sort((p, q) => indexOf(p.customId) - indexOf(q.customId))
      .map((item: BatchItemResult) => ({ ...unpack(item.structuredOutput), costUsd: item.usage.actualCostUsd, ...equivalentOf(item.usage), tokens: tokensOf(item.usage) }));
  }
}
