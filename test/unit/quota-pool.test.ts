import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountDef, PoolDef, QuotaExhaustedError } from '../../src/quota.js';
import { HarnessStore } from '../../src/store.js';
import type {
  Driver,
  DriverInvokeRequest,
  DriverInvokeResult,
  QuotaPatch,
  QuotaPolicy,
} from '../../src/types.js';

const HOURLY = 'acme:hourly';
const WEEKLY = 'acme:weekly';

function createDummyDriver(opts?: {
  probe?: (id: string) => Promise<QuotaPatch>;
  quotaPolicy?: Partial<QuotaPolicy>;
}): Driver {
  return {
    kind: 'mock',
    quotaPolicy: opts?.quotaPolicy,
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
    probeQuota: opts?.probe,
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
    vi.useRealTimers();
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

  it('orders accounts by the reset of the share window for drain-soonest-expiring and by peak usage for least-used', async () => {
    const store = makeStore();
    const driver = createDummyDriver({ quotaPolicy: { shareResetWindowId: WEEKLY } });
    const now = Date.now();

    const acctA = new AccountDef('acct-a', driver);
    const acctB = new AccountDef('acct-b', driver);
    const acctC = new AccountDef('acct-c', driver);

    store.upsertAccountQuota('acct-a', {
      windows: [
        { id: HOURLY, utilization: 0.20 },
        { id: WEEKLY, utilization: 0.10, resetsAtMs: now + 4 * 24 * 3600_000 },
      ],
    });
    store.upsertAccountQuota('acct-b', {
      windows: [
        { id: HOURLY, utilization: 0.40 },
        { id: WEEKLY, utilization: 0.10, resetsAtMs: now + 1 * 24 * 3600_000 },
      ],
    });
    store.upsertAccountQuota('acct-c', {
      windows: [
        { id: HOURLY, utilization: 0.10 },
        { id: WEEKLY, utilization: 0.30, resetsAtMs: now + 1 * 24 * 3600_000 },
      ],
    });

    const drainPool = new PoolDef('drain-pool', [acctA, acctB, acctC]).strategy(
      'drain-soonest-expiring',
    );
    expect.soft((await drainPool.acquireAccount(store)).accountId).toBe('acct-c');

    const leastUsedPool = new PoolDef('least-pool', [acctA, acctB, acctC]).strategy('least-used');
    expect.soft((await leastUsedPool.acquireAccount(store)).accountId).toBe('acct-a');
    store.close();
  });

  it('fails over on any provider window that crosses its per-window threshold', async () => {
    const store = makeStore();
    const driver = createDummyDriver();
    const rpmCapped = new AccountDef('openai-1', driver).quotaPolicy({
      thresholds: { 'openai:rpm': 0.9 },
    });
    const spare = new AccountDef('openai-2', driver);

    store.upsertAccountQuota('openai-1', { windows: [{ id: 'openai:rpm', utilization: 0.92 }] });
    store.upsertAccountQuota('openai-2', { windows: [{ id: 'openai:rpm', utilization: 0.92 }] });

    const pool = new PoolDef('openai-pool', [rpmCapped, spare]).strategy('priority');
    expect.soft((await pool.acquireAccount(store)).accountId).toBe('openai-2');

    store.upsertAccountQuota('openai-2', { windows: [{ id: 'openai:tpd', utilization: 0.95 }] });
    await expect(pool.acquireAccount(store)).rejects.toBeInstanceOf(QuotaExhaustedError);
    store.close();
  });

  it('recovers accounts when windows or cooldowns expire, and when a probe shows the share window was reset early', async () => {
    const store = makeStore();
    let remoteWeekly = 0.85;
    const probedDriver = createDummyDriver({
      quotaPolicy: { shareResetWindowId: WEEKLY },
      probe: async () => ({
        windows: [
          { id: HOURLY, utilization: 0.05 },
          { id: WEEKLY, utilization: remoteWeekly },
        ],
      }),
    });

    const acct = new AccountDef('acct-reactive', probedDriver).maxQuotaShare(0.50);
    await acct.evaluateEligibility(store, 1.0, Date.now());
    store.upsertAccountQuota('acct-reactive', {
      windows: [
        { id: HOURLY, utilization: 0.96, resetsAtMs: Date.now() - 1000 },
        { id: WEEKLY, utilization: 0.85, resetsAtMs: Date.now() + 3600_000 },
      ],
      projectShareUsed: 0.50,
      windowTokensUsed: 2_500_000,
      cooldownUntilMs: Date.now() - 500,
    });

    await expect(acct.acquireAccount(store)).rejects.toBeInstanceOf(QuotaExhaustedError);

    remoteWeekly = 0.10;
    const evaluation = await acct.evaluateEligibility(store, 1.0, Date.now() + 120_000);
    expect.soft(evaluation.isEligible).toBe(true);
    expect.soft(evaluation.projectShareUsed).toBe(0);
    expect.soft(store.getAccountQuota('acct-reactive')?.windowTokensUsed).toBe(0);
    store.close();
  });

  it('clears project share and window tokens when the share window reset time passes, keeping the driver policy under an account override', async () => {
    const store = makeStore();
    const driver = createDummyDriver({ quotaPolicy: { shareResetWindowId: WEEKLY } });
    const acct = new AccountDef('acct-weekly', driver)
      .quotaPolicy({ defaultThreshold: 0.99 })
      .maxQuotaShare(0.50);
    store.upsertAccountQuota('acct-weekly', {
      windows: [{ id: WEEKLY, utilization: 0.60, resetsAtMs: Date.now() - 1 }],
      projectShareUsed: 0.50,
      windowTokensUsed: 2_500_000,
    });

    const evaluation = await acct.evaluateEligibility(store, 1.0, Date.now());
    expect.soft(evaluation.isEligible).toBe(true);
    expect.soft(store.getAccountQuota('acct-weekly')?.windowTokensUsed).toBe(0);
    store.close();
  });

  it('re-probes an account that keeps being acquired once the probe goes stale', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.UTC(2026, 9, 31, 12);
    vi.setSystemTime(start);
    const store = makeStore();
    let probes = 0;
    const driver = createDummyDriver({
      quotaPolicy: { probeStalenessMs: 60_000 },
      probe: async () => {
        probes += 1;
        return { windows: [{ id: HOURLY, utilization: 0.1 }] };
      },
    });
    const acct = new AccountDef('acct-busy', driver);

    await acct.acquireAccount(store);
    vi.setSystemTime(start + 40_000);
    await acct.acquireAccount(store);
    vi.setSystemTime(start + 80_000);
    await acct.acquireAccount(store);

    expect(probes).toBe(2);
    store.close();
  });

  it('respects reserve configuration and routes to fallback account when pool is exhausted', async () => {
    const store = makeStore();
    const driver = createDummyDriver();
    const acct1 = new AccountDef('sub-1', driver);
    const acct2 = new AccountDef('sub-2', driver);
    const fallbackApi = new AccountDef('api-fallback', driver);

    store.upsertAccountQuota('sub-1', { windows: [{ id: HOURLY, utilization: 0.80 }] });
    store.upsertAccountQuota('sub-2', { windows: [{ id: HOURLY, utilization: 0.20 }] });

    const pool = new PoolDef('reserved-pool', [acct1, acct2])
      .reserve({ minFreeAccounts: 1, maxBurstUtilization: 0.50 })
      .fallback(fallbackApi);

    const resolved = await pool.acquireAccount(store);
    expect.soft(resolved.accountId).toBe('api-fallback');
    store.close();
  });
});
