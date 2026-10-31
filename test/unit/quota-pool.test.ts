import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { H, z } from '../../src/index.js';
import { AccountDef, applyQuotaPatch, PoolDef, QuotaExhaustedError } from '../../src/quota.js';
import { HarnessStore } from '../../src/store.js';
import type {
  Driver,
  DriverInvokeRequest,
  DriverInvokeResult,
  QuotaPatch,
  QuotaPolicy,
} from '../../src/types.js';

const HOURLY = 'acme:hourly';
const DAY = 24 * 3600_000;
const MINUTE = 60_000;
const NOW = Date.UTC(2026, 9, 31, 12);
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

  it('replaces, not merges, an earlier account policy override', () => {
    const acct = new AccountDef('acct-p', createDummyDriver())
      .quotaPolicy({ tokenBudget: 1_000, defaultThreshold: 0.5 })
      .quotaPolicy({ defaultThreshold: 0.7 });
    expect.soft(acct.effectiveQuotaPolicy.defaultThreshold).toBe(0.7);
    expect(acct.effectiveQuotaPolicy.tokenBudget).toBeNull();
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

  it.each([
    { label: 'uses a non-reserved account before the fallback', subOne: 0.8, fallback: true, expected: 'sub-1' },
    { label: 'routes to the fallback when only reserved accounts are left', subOne: 0.96, fallback: true, expected: 'api-fallback' },
    { label: 'uses a reserved account when there is no fallback', subOne: 0.96, fallback: false, expected: 'sub-2' },
  ])('reserve: $label', async ({ subOne, fallback, expected }) => {
    const store = makeStore();
    const driver = createDummyDriver();
    store.upsertAccountQuota('sub-1', { windows: [{ id: HOURLY, utilization: subOne }] });
    store.upsertAccountQuota('sub-2', { windows: [{ id: HOURLY, utilization: 0.20 }] });
    const reserved = new PoolDef('reserved-pool', [new AccountDef('sub-1', driver), new AccountDef('sub-2', driver)])
      .strategy('priority')
      .reserve({ minFreeAccounts: 1, maxBurstUtilization: 0.50 });
    const pool = fallback ? reserved.fallback(new AccountDef('api-fallback', driver)) : reserved;

    expect((await pool.acquireAccount(store)).accountId).toBe(expected);
    store.close();
  });

  it.each([
    { label: 'reset early (utilization dropped)', reported: { utilization: 0.01, resetsAtMs: 3 * DAY } },
    { label: 'rolled over during a run (reset time moved later)', reported: { utilization: 0.65, resetsAtMs: 10 * DAY } },
  ])('frees the project share when a run reports that the share window $label', async ({ reported }) => {
    const store = makeStore();
    const now = Date.now();
    const acct = new AccountDef('acct-hint', createDummyDriver({ quotaPolicy: { shareResetWindowId: WEEKLY } })).maxQuotaShare(0.5);
    store.upsertAccountQuota('acct-hint', {
      windows: [{ id: WEEKLY, utilization: 0.6, resetsAtMs: now + 3 * DAY }],
      projectShareUsed: 0.5,
      windowTokensUsed: 2_500_000,
    });

    applyQuotaPatch(store, 'acct-hint', acct.effectiveQuotaPolicy, {
      windows: [{ id: WEEKLY, utilization: reported.utilization, resetsAtMs: now + reported.resetsAtMs }],
    });

    const evaluation = await acct.evaluateEligibility(store, 1, now);
    expect.soft(store.getAccountQuota('acct-hint')?.windowTokensUsed).toBe(0);
    expect(evaluation.projectShareUsed).toBe(0);
    store.close();
  });

  it('stops blocking on a window without a reset time once it is older than the probe staleness', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.UTC(2026, 9, 31, 12);
    vi.setSystemTime(start);
    const store = makeStore();
    const acct = new AccountDef('acct-stale', createDummyDriver({ quotaPolicy: { probeStalenessMs: 60_000 } }));
    store.upsertAccountQuota('acct-stale', { windows: [{ id: 'http:ratelimit', utilization: 0.98 }] });

    expect.soft((await acct.evaluateEligibility(store, 1, start + 30_000)).isEligible).toBe(false);
    expect((await acct.evaluateEligibility(store, 1, start + 61_000)).isEligible).toBe(true);
    store.close();
  });

  it.each([
    {
      label: 'the active cooldown, not an unrelated window reset',
      quota: { cooldownUntilMs: NOW + 10 * MINUTE, windows: [{ id: HOURLY, utilization: 0.1, resetsAtMs: NOW + MINUTE }] },
      expected: NOW + 10 * MINUTE,
    },
    {
      label: 'the latest end among blocking conditions',
      quota: {
        cooldownUntilMs: NOW + MINUTE,
        windows: [{ id: WEEKLY, utilization: 0.99, resetsAtMs: NOW + DAY }],
      },
      expected: NOW + DAY,
    },
    {
      label: 'the staleness end of a blocking window without a reset time',
      quota: { windows: [{ id: WEEKLY, utilization: 0.99 }] },
      expected: NOW + MINUTE,
    },
    {
      label: 'unknown when the share cap blocks and no share window reset is known',
      quota: { projectShareUsed: 1 },
      expected: null,
    },
  ])('reports the next available time as $label', async ({ quota, expected }) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const store = makeStore();
    const acct = new AccountDef('acct-next', createDummyDriver());
    store.upsertAccountQuota('acct-next', quota);

    const evaluation = await acct.evaluateEligibility(store, 1, NOW);
    expect.soft(evaluation.isEligible).toBe(false);
    expect(evaluation.nextAvailableAtMs).toBe(expected);
    store.close();
  });

  it("charges each invocation against its own account policy's token budget", async () => {
    const store = makeStore();
    let unbudgeted: AccountDef | undefined;
    const driver: Driver = {
      ...createDummyDriver(),
      async invoke(req) {
        await unbudgeted!.evaluateEligibility(store, 1, Date.now());
        return createDummyDriver().invoke(req);
      },
    };
    const budgeted = new AccountDef('shared', driver).quotaPolicy({ tokenBudget: 1_000 });
    unbudgeted = new AccountDef('shared', driver);
    store.createRun({ id: 'run-q', flowName: 'f', workDir: store.projectDir, input: {} });
    const ctx = {
      runId: 'run-q',
      iteration: 0,
      stepName: 'step',
      projectDir: store.projectDir,
      workDir: store.projectDir,
      touchedPaths: [],
      store,
      signal: new AbortController().signal,
    };

    await H.agent('a').model(H.model(budgeted, 'm')).run(H.skill('s').input(z.object({})).output(z.object({}))).execute({}, ctx);
    expect(store.getAccountQuota('shared')?.projectShareUsed).toBeCloseTo(0.02, 9);
    store.close();
  });
});
