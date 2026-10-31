import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FlowEngine, H, HarnessStore, z } from '../../src/index.js';

const hasAnthropicApiKey = Boolean(process.env.ANTHROPIC_API_KEY);

describe('Live E2E 2: AI SDK Structured Output & Batch Execution', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasAnthropicApiKey)(
    'executes live AI SDK structured output, a 2-item H.batch flow, and live Anthropic Cloud Batch API submission',
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'harness-e2e-sdk-'));
      tempDirs.push(dir);
      const store = new HarnessStore(dir);
      const engine = new FlowEngine(store);

      const SdkAcct = H.account(
        'anthropic-sdk',
        H.drivers.aiSdk({
          provider: 'anthropic',
          apiKeyEnv: 'ANTHROPIC_API_KEY',
          batch: false,
        }),
      );
      const Haiku = H.model(SdkAcct, 'claude-haiku-5-5', { cachePrefix: true });

      const ClassifySkill = H.skill('classify')
        .input(z.object({ text: z.string() }))
        .output(z.object({ sentiment: z.enum(['positive', 'negative', 'neutral']) }));

      const Classifier = H.agent('classifier')
        .model(Haiku)
        .prompt('Classify the sentiment of the input text.');

      const flow = H.flow('sdk-batch-flow')
        .input(z.object({ texts: z.array(z.string()) }))
        .batch('classifications', {
          items: (ctx) => ctx.input.texts.map((text) => ({ text })),
          execute: Classifier.run(ClassifySkill),
          concurrency: 2,
        });

      const res = await engine.run(flow, {
        texts: [
          'The build succeeded on the first try and all tests passed!',
          'The server crashed with a fatal segmentation fault.',
        ],
      });

      expect.soft(res.steps.classifications).toEqual([
        { sentiment: 'positive' },
        { sentiment: 'negative' },
      ]);

      const cloudBatchDriver = H.drivers.aiSdk({
        provider: 'anthropic',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
      });
      const submitted = await cloudBatchDriver.batch!.submit(
        [
          {
            customId: 'live-batch-0',
            systemPrompt: 'Return structured output.',
            userPrompt: 'Classify: All systems green',
            outputJsonSchema: {
              type: 'object',
              properties: { ok: { type: 'boolean' } },
              required: ['ok'],
              additionalProperties: false,
            },
          },
          {
            customId: 'live-batch-1',
            systemPrompt: 'Return structured output.',
            userPrompt: 'Classify: Deployment verified',
            outputJsonSchema: {
              type: 'object',
              properties: { ok: { type: 'boolean' } },
              required: ['ok'],
              additionalProperties: false,
            },
          },
        ],
        'claude-haiku-5-5',
        {},
      );
      expect.soft(submitted.batchId.startsWith('msgbatch_')).toBe(true);
      await cloudBatchDriver.batch!.cancel?.(submitted.batchId);

      const telemetry = readFileSync(store.telemetryPath, 'utf8');
      expect.soft(telemetry).toContain('anthropic-sdk');
      expect.soft(telemetry).toContain('## Per-Run Breakdown');
      expect.soft(telemetry).toContain('## Per-Agent Scorecard');
      store.close();
    },
    90_000,
  );
});
