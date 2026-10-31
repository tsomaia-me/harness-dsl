import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FlowEngine, H, HarnessStore, z } from '../../src/index.js';

const hasClaudeCliCreds = Boolean(
  process.env.CLAUDE_CONFIG_DIR_1 ||
    process.env.CLAUDE_CODE_OAUTH_TOKEN ||
    process.env.ANTHROPIC_API_KEY,
);

describe('Live E2E 1: Claude CLI Pool & Quota Failover', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasClaudeCliCreds)(
    'spawns real claude -p against subscription pool with --json-schema, records token usage, and fails over when account 1 hits maxQuotaShare',
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'harness-e2e-cli-'));
      tempDirs.push(dir);
      const store = new HarnessStore(dir);
      const engine = new FlowEngine(store);

      const Acct1 = H.account(
        'sub-1',
        H.drivers.claudeCli({
          configDir: process.env.CLAUDE_CONFIG_DIR_1 ?? '~/.claude',
        }),
      ).maxQuotaShare(0.5);

      const Acct2 = H.account(
        'sub-2',
        H.drivers.claudeCli({
          configDir: process.env.CLAUDE_CONFIG_DIR_2 ?? '~/.claude-google',
        }),
      ).maxQuotaShare(0.8);

      const Acct3 = H.account(
        'sub-3',
        H.drivers.claudeCli({
          configDir: process.env.CLAUDE_CONFIG_DIR_3 ?? '~/.claude-apple',
        }),
      ).maxQuotaShare(0.8);

      const FallbackAcct = H.account(
        'api-fallback',
        H.drivers.aiSdk({ provider: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' }),
      );

      const Pool = H.pool('live-subs', [Acct1, Acct2, Acct3])
        .strategy('priority')
        .fallback(FallbackAcct);
      const Model = H.model(Pool, 'claude-haiku-4-5');

      const MathSkill = H.skill('math-check')
        .input(z.object({ a: z.number(), b: z.number() }))
        .output(z.object({ sum: z.number(), product: z.number() }))
        .prompt((input) => `Compute sum and product of ${input.a} and ${input.b}.`);

      const Agent = H.agent('calculator').model(Model).prompt('Return exact arithmetic results.');

      const flow = H.flow('math-flow')
        .input(z.object({ a: z.number(), b: z.number() }))
        .step('calc1', Agent.run(MathSkill, (ctx) => ctx.input))
        .step(
          'exhaustAcct1',
          H.command('cap-acct1')
            .input(z.any())
            .output(z.object({ capped: z.boolean() }))
            .run(async ({ ctx }) => {
              ctx.store.upsertAccountQuota('sub-1', { projectShareUsed: 0.5 });
              return { capped: true };
            }),
        )
        .step('calc2', Agent.run(MathSkill, (ctx) => ({ a: ctx.input.a + 1, b: ctx.input.b })));

      const res = await engine.run(flow, { a: 6, b: 7 });
      expect.soft(res.steps.calc1).toEqual({ sum: 13, product: 42 });
      expect.soft(res.steps.calc2).toEqual({ sum: 14, product: 49 });

      const passedInvs = store
        .listInvocations()
        .filter((i) => i.actorKind === 'agent' && i.status === 'pass');
      expect.soft(passedInvs.length).toBe(2);
      expect.soft(passedInvs[0]?.accountId).toBe('sub-1');
      expect.soft(passedInvs[1]?.accountId).not.toBe('sub-1');
      store.close();
    },
    120_000,
  );
});
