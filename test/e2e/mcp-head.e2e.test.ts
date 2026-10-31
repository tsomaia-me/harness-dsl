import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { H, startOrchestrator, z } from '../../src/index.js';

const hasAnthropicApiKey = Boolean(process.env.ANTHROPIC_API_KEY);

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe('Live E2E 4: Head HTTP MCP Server & Blocker Resolution Round-Trip', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasAnthropicApiKey)(
    'connects real MCP client over Streamable HTTP, calls harness_ground, invokes a live agent .tool(), and resolves a halted workflow via blocker_resolve',
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'harness-e2e-mcp-'));
      tempDirs.push(dir);

      const SdkAcct = H.account(
        'head-tool-sdk',
        H.drivers.aiSdk({
          provider: 'anthropic',
          apiKeyEnv: 'ANTHROPIC_API_KEY',
          batch: false,
        }),
      );
      const Haiku = H.model(SdkAcct, 'claude-haiku-4-5-20251001');

      const PingSkill = H.skill('ping-advisor')
        .input(z.object({ question: z.string() }))
        .output(z.object({ answer: z.string() }));

      const Advisor = H.agent('advisor')
        .model(Haiku)
        .prompt('Answer concisely in one short sentence.');

      const WaitFlow = H.flow('deploy-approval')
        .input(z.object({ env: z.string() }))
        .haltIf(
          (ctx) => ctx.input.env === 'prod',
          () => ({ reason: 'Confirm production release' }),
        )
        .step(
          'ship',
          H.command('ship')
            .input(z.any())
            .output(z.object({ deployed: z.boolean() }))
            .run(async () => ({ deployed: true })),
        );

      const head = H.head()
        .port(0)
        .capabilities(['workflows:read', 'workflows:control', 'blockers:resolve'])
        .tool('ask_advisor', Advisor.run(PingSkill))
        .registerFlow(WaitFlow);

      const orch = await startOrchestrator({ projectDir: dir, head });
      const client = new Client({ name: 'e2e-head', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(orch.mcpUrl));
      await client.connect(transport);

      const groundRes = await client.callTool({
        name: 'harness_ground',
        arguments: { sessionId: 'live-head-1' },
      });
      const groundJson = JSON.parse(((groundRes.content as any)[0] as any).text);
      expect.soft(groundJson.sessionId).toBe('live-head-1');

      const toolRes = await client.callTool({
        name: 'ask_advisor',
        arguments: { question: 'What is 2 + 2?' },
      });
      const toolJson = JSON.parse(((toolRes.content as any)[0] as any).text);
      expect.soft(typeof toolJson.result?.answer).toBe('string');
      expect.soft(toolJson.result.answer.length).toBeGreaterThan(0);

      await client.callTool({
        name: 'workflow_start',
        arguments: {
          flowName: 'deploy-approval',
          runId: 'run-prod-1',
          input: { env: 'prod' },
        },
      });

      await waitFor(() => orch.store.getRun('run-prod-1')?.status === 'blocked');
      expect.soft(orch.store.getRun('run-prod-1')?.status).toBe('blocked');
      expect.soft(existsSync(orch.store.boardPath)).toBe(true);

      await client.callTool({
        name: 'blocker_resolve',
        arguments: {
          runId: 'run-prod-1',
          resolution: { ok: true },
        },
      });

      await waitFor(() => orch.store.getRun('run-prod-1')?.status === 'completed');
      expect.soft(orch.store.getRun('run-prod-1')?.status).toBe('completed');

      await client.close();
      await orch.close();
    },
    90_000,
  );
});
