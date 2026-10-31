import { randomUUID } from 'node:crypto';
import type {
  BatchAdapter,
  BatchItemRequest,
  BatchItemResult,
  Driver,
  DriverInvokeRequest,
  DriverInvokeResult,
  QuotaPatch,
} from '../types.js';

export type MockInvokeHandler = (
  req: DriverInvokeRequest,
  callIndex: number,
) => Promise<Partial<DriverInvokeResult> & { structuredOutput: unknown }> | (Partial<DriverInvokeResult> & { structuredOutput: unknown });

export interface MockDriverOptions {
  readonly handler?: MockInvokeHandler;
  readonly responses?: readonly (Partial<DriverInvokeResult> & { structuredOutput: unknown })[];
  readonly probeQuota?: (accountId: string) => Promise<QuotaPatch>;
  readonly enableBatch?: boolean;
}

export class MockDriver implements Driver {
  public readonly kind = 'mock';
  public readonly calls: DriverInvokeRequest[] = [];
  public readonly batchSubmits: BatchItemRequest[][] = [];
  public readonly probeQuota?: (accountId: string) => Promise<QuotaPatch>;
  public readonly batch?: BatchAdapter;
  private readonly handler?: MockInvokeHandler;
  private readonly responses: readonly (Partial<DriverInvokeResult> & { structuredOutput: unknown })[];

  public constructor(opts?: MockDriverOptions) {
    this.handler = opts?.handler;
    this.responses = opts?.responses ?? [];
    this.probeQuota = opts?.probeQuota;

    if (opts?.enableBatch) {
      const batches = new Map<string, BatchItemResult[]>();
      this.batch = {
        submit: async (items, modelId, modelOptions) => {
          this.batchSubmits.push([...items]);
          const batchId = `batch-${randomUUID()}`;
          const results: BatchItemResult[] = [];
          for (const item of items) {
            const res = await this.invoke({
              accountId: 'batch-mock',
              modelId,
              modelOptions,
              systemPrompt: item.systemPrompt,
              userPrompt: item.userPrompt,
              outputJsonSchema: item.outputJsonSchema,
              workDir: process.cwd(),
              runId: batchId,
              stepName: item.customId,
              inactivityTimeoutMs: 30_000,
              signal: new AbortController().signal,
            });
            results.push({
              customId: item.customId,
              ok: true,
              structuredOutput: res.structuredOutput,
              usage: {
                ...res.usage,
                actualCostUsd:
                  res.usage.actualCostUsd === null ? null : res.usage.actualCostUsd * 0.5,
              },
            });
          }
          batches.set(batchId, results);
          return { batchId };
        },
        poll: async (batchId) => {
          const results = batches.get(batchId);
          if (!results) return { status: 'failed' };
          return { status: 'completed', results };
        },
      };
    }
  }

  public async invoke(req: DriverInvokeRequest): Promise<DriverInvokeResult> {
    const idx = this.calls.length;
    this.calls.push(req);

    let partial: Partial<DriverInvokeResult> & { structuredOutput: unknown };
    if (this.handler) {
      partial = await this.handler(req, idx);
    } else if (this.responses.length > 0) {
      const pick = this.responses[Math.min(idx, this.responses.length - 1)]!;
      partial = pick;
    } else {
      partial = { structuredOutput: {} };
    }

    return {
      structuredOutput: partial.structuredOutput,
      rawText: partial.rawText ?? JSON.stringify(partial.structuredOutput),
      sessionId: partial.sessionId ?? req.sessionId ?? `mock-session-${idx + 1}`,
      usage: partial.usage ?? {
        inputTokens: 100,
        cachedInputTokens: 50,
        outputTokens: 40,
        actualCostUsd: 0,
        equivalentCostUsd: 0.005,
      },
      handoffRequested: partial.handoffRequested,
      quotaHint: partial.quotaHint,
    };
  }
}
