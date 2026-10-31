import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountDef, parseRateLimitHeaders, PoolDef, QuotaExhaustedError } from '../../src/quota.js';
import { HarnessStore } from '../../src/store.js';
import type { Driver, DriverInvokeRequest, DriverInvokeResult, QuotaSnapshot } from '../../src/types.js';

function createDummyDriver(probeFn?: (id: string) => Promise<Partial<QuotaSnapshot>>): Driver {
  return {
    kind: 'mock',
    async invoke(_req: DriverInvokeRequest): Promise<DriverInvokeResult> {
      return {
        structuredOutput: {},
        rawText: '{}',
        sessionId: 'sess-1',
        usage: {
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 10,
          actualCostUsd: 0,
          equivalentCostUsd: 0.01,
        },
      };
    },
    probeQuota: probeFn,
  };
}

describe('Reactive Account Pool & Quota Engine', () => {
  const tempDirs: string[] = [];

  function makeStore(): HarnessStore {
    const dir = mkdtempSync(path.join(tmpdir(), 'harness-quota-test-'));
    tempDirs.push(dir);
    return new HarnessStore(dir);
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enforces both individual account maxQuotaShare and pool maxQuotaShare', async () => {
    const store = makeStore();
    const driver = createDummyDriver();

    const acct1 = new AccountDef('acct-1', driver).maxQuotaShare(0.75);
    const acct2 = new AccountDef('acct-2', driver).maxQuotaShare(0.75);
    const acct3 = new AccountDef('acct-3', driver).maxQuotaShare(0.20);

    const pool = new PoolDef('subs', [acct1, acct2, acct3])
      .maxQuotaShare(0.60)
      .strategy('priority');

    store.upsertAccountQuota('acct-1', { projectShareUsed: 0.60 });
    store.upsertAccountQuota('acct-2', { projectShareUsed: 0.59 });
    store.upsertAccountQuota('acct-3', { projectShareUsed: 0.20 });

    const picked1 = await pool.acquireAccount(store);
    expect.soft(picked1.accountId).toBe('acct-2');
    expect.soft(picked1.maxQuotaShare).toBe(0.60);

    store.upsertAccountQuota('acct-2', { projectShareUsed: 0.60 });
    store.upsertAccountQuota('acct-3', { projectShareUsed: 0.19 });

    const picked2 = await pool.acquireAccount(store);
    expect.soft(picked2.accountId).toBe('acct-3');
    expect.soft(picked2.maxQuotaShare).toBe(0.20);

    store.upsertAccountQuota('acct-3', { projectShareUsed: 0.20 });
    await expect(pool.acquireAccount(store)).rejects.toBeInstanceOf(QuotaExhaustedError);
    store.close();
  });

  it('orders accounts by drain-soonest-expiring and least-used strategies', async () => {
    const store = makeStore();
    const driver = createDummyDriver();
    const now = Date.now();

    const acctA = new AccountDef('acct-a', driver);
    const acctB = new AccountDef('acct-b', driver);
    const acctC = new AccountDef('acct-c', driver);

    store.upsertAccountQuota('acct-a', {
      utilization5h: 0.20,
      resets7dAtMs: now + 4 * 24 * 3600_000,
    });
    store.upsertAccountQuota('acct-b', {
      utilization5h: 0.40,
      resets7dAtMs: now + 1 * 24 * 3600_000,
    });
    store.upsertAccountQuota('acct-c', {
      utilization5h: 0.10,
      resets7dAtMs: now + 1 * 24 * 3600_000,
    });

    const drainPool = new PoolDef('drain-pool', [acctA, acctB, acctC]).strategy(
      'drain-soonest-expiring',
    );
    const firstDrain = await drainPool.acquireAccount(store);
    expect.soft(firstDrain.accountId).toBe('acct-c');

    const leastUsedPool = new PoolDef('least-pool', [acctA, acctB, acctC]).strategy('least-used');
    const firstLeast = await leastUsedPool.acquireAccount(store);
    expect.soft(firstLeast.accountId).toBe('acct-c');
    store.close();
  });

  it('automatically recovers accounts when reset windows or cooldowns expire or when early reset is probed', async () => {
    const store = makeStore();
    let remote7d = 0.85;
    const probedDriver = createDummyDriver(async () => ({
      utilization5h: 0.05,
      utilization7d: remote7d,
    }));

    const acct = new AccountDef('acct-reactive', probedDriver).maxQuotaShare(0.50);
    store.upsertAccountQuota('acct-reactive', {
      utilization5h: 0.96,
      utilization7d: 0.85,
      projectShareUsed: 0.50,
      resets5hAtMs: Date.now() - 1000,
      resets7dAtMs: Date.now() + 3600_000,
      cooldownUntilMs: Date.now() - 500,
    });

    await expect(acct.acquireAccount(store)).rejects.toBeInstanceOf(QuotaExhaustedError);

    remote7d = 0.10;
    const evaluation = await acct.evaluateEligibility(store, 1.0, Date.now() + 120_000);
    expect.soft(evaluation.isEligible).toBe(true);
    expect.soft(evaluation.projectShareUsed).toBe(0);
    store.close();
  });

  it('respects reserve configuration and routes to fallback account when pool is exhausted', async () => {
    const store = makeStore();
    const driver = createDummyDriver();
    const acct1 = new AccountDef('sub-1', driver);
    const acct2 = new AccountDef('sub-2', driver);
    const fallbackApi = new AccountDef('api-fallback', driver);

    store.upsertAccountQuota('sub-1', { utilization5h: 0.80 });
    store.upsertAccountQuota('sub-2', { utilization5h: 0.20 });

    const pool = new PoolDef('reserved-pool', [acct1, acct2])
      .reserve({ minFreeAccounts: 1, maxBurstUtilization: 0.50 })
      .fallback(fallbackApi);

    const resolved = await pool.acquireAccount(store);
    expect.soft(resolved.accountId).toBe('api-fallback');
    store.close();
  });

  it('parses Anthropic unified rate-limit and retry-after headers', () => {
    const now = 1_700_000_000_000;
    const parsed = parseRateLimitHeaders(
      {
        'anthropic-ratelimit-unified-5h-utilization': '0.42',
        'anthropic-ratelimit-unified-7d-utilization': '0.71',
        'anthropic-ratelimit-unified-5h-reset': '1700003600',
        'anthropic-ratelimit-unified-7d-reset': '1700086400',
        'retry-after': '30',
      },
      now,
    );
    expect(parsed).toEqual({
      utilization5h: 0.42,
      utilization7d: 0.71,
      resets5hAtMs: 1_700_003_600_000,
      resets7dAtMs: 1_700_086_400_000,
      cooldownUntilMs: now + 30_000,
    });
  });
});
