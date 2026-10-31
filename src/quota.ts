import type { HarnessStore } from './store.js';
import type { AccountProvider, Driver, QuotaSnapshot, ResolvedAccount } from './types.js';

export type PoolStrategy = 'drain-soonest-expiring' | 'least-used' | 'priority' | 'round-robin';

export interface PoolReserveConfig {
  readonly minFreeAccounts: number;
  readonly maxBurstUtilization: number;
}

export class QuotaExhaustedError extends Error {
  public readonly nextAvailableAtMs: number | null;

  public constructor(poolOrAccountId: string, nextAvailableAtMs: number | null) {
    super(
      `Quota exhausted for "${poolOrAccountId}"${
        nextAvailableAtMs ? ` (next available at ${new Date(nextAvailableAtMs).toISOString()})` : ''
      }`,
    );
    this.name = 'QuotaExhaustedError';
    this.nextAvailableAtMs = nextAvailableAtMs;
  }
}

export class AccountDef implements AccountProvider {
  public readonly id: string;
  public readonly driver: Driver;
  public readonly maxQuotaShareValue: number;

  public constructor(id: string, driver: Driver, maxQuotaShareValue = 1.0) {
    if (maxQuotaShareValue <= 0 || maxQuotaShareValue > 1) {
      throw new Error(`Invalid maxQuotaShare ${maxQuotaShareValue} for account ${id}`);
    }
    this.id = id;
    this.driver = driver;
    this.maxQuotaShareValue = maxQuotaShareValue;
  }

  public maxQuotaShare(ratio: number): this {
    return new AccountDef(this.id, this.driver, ratio) as this;
  }

  public async acquireAccount(store: HarnessStore): Promise<ResolvedAccount> {
    const eligible = await this.evaluateEligibility(store, 1.0, Date.now());
    if (!eligible.isEligible) {
      throw new QuotaExhaustedError(this.id, eligible.nextAvailableAtMs);
    }
    store.upsertAccountQuota(this.id, { updatedAtMs: Date.now() });
    return {
      accountId: this.id,
      driver: this.driver,
      maxQuotaShare: eligible.effectiveShareCap,
    };
  }

  public async evaluateEligibility(
    store: HarnessStore,
    poolMaxQuotaShare: number,
    nowMs: number,
  ): Promise<{
    readonly account: AccountDef;
    readonly isEligible: boolean;
    readonly effectiveShareCap: number;
    readonly utilization5h: number;
    readonly utilization7d: number;
    readonly projectShareUsed: number;
    readonly resets5hAtMs: number | null;
    readonly resets7dAtMs: number | null;
    readonly updatedAtMs: number;
    readonly nextAvailableAtMs: number | null;
  }> {
    let row = store.getAccountQuota(this.id);
    const priorUpdatedAtMs = row?.updatedAtMs ?? 0;

    if (row) {
      let needsResetUpdate = false;
      const patch: { -readonly [K in keyof QuotaSnapshot]?: QuotaSnapshot[K] } & {
        projectShareUsed?: number;
        updatedAtMs?: number;
      } = { updatedAtMs: priorUpdatedAtMs };
      if (row.resets5hAtMs !== null && nowMs >= row.resets5hAtMs) {
        patch.utilization5h = 0;
        patch.resets5hAtMs = null;
        needsResetUpdate = true;
      }
      if (row.resets7dAtMs !== null && nowMs >= row.resets7dAtMs) {
        patch.utilization7d = 0;
        patch.projectShareUsed = 0;
        patch.resets7dAtMs = null;
        needsResetUpdate = true;
      }
      if (row.cooldownUntilMs !== null && nowMs >= row.cooldownUntilMs) {
        patch.cooldownUntilMs = null;
        needsResetUpdate = true;
      }
      if (needsResetUpdate) {
        store.upsertAccountQuota(this.id, patch);
        row = store.getAccountQuota(this.id);
      }
    }

    if (this.driver.probeQuota && (!row || nowMs - priorUpdatedAtMs > 60_000)) {
      const probed = await this.driver.probeQuota(this.id);
      const patch: Partial<QuotaSnapshot> & { projectShareUsed?: number; updatedAtMs?: number } = {
        ...probed,
        updatedAtMs: nowMs,
      };
      if (
        row &&
        probed.utilization7d !== undefined &&
        probed.utilization7d < row.utilization7d
      ) {
        patch.projectShareUsed = 0;
      }
      store.upsertAccountQuota(this.id, patch);
      row = store.getAccountQuota(this.id);
    }

    const utilization5h = row?.utilization5h ?? 0;
    const utilization7d = row?.utilization7d ?? 0;
    const projectShareUsed = row?.projectShareUsed ?? 0;
    const resets5hAtMs = row?.resets5hAtMs ?? null;
    const resets7dAtMs = row?.resets7dAtMs ?? null;
    const cooldownUntilMs = row?.cooldownUntilMs ?? null;
    const updatedAtMs = row?.updatedAtMs ?? 0;

    const overrideShare = store.getAccountShareOverride(this.id);
    const baseAccountCap = overrideShare ?? this.maxQuotaShareValue;
    const effectiveShareCap = Math.min(baseAccountCap, poolMaxQuotaShare);
    const inCooldown = cooldownUntilMs !== null && cooldownUntilMs > nowMs;
    const overShare = projectShareUsed >= effectiveShareCap;
    const over5h = utilization5h >= 0.95;
    const over7d = utilization7d >= 0.98;

    const isEligible = !inCooldown && !overShare && !over5h && !over7d;

    const candidates = [cooldownUntilMs, resets5hAtMs, resets7dAtMs].filter(
      (v): v is number => v !== null && v > nowMs,
    );
    const nextAvailableAtMs = candidates.length > 0 ? Math.min(...candidates) : null;

    return {
      account: this,
      isEligible,
      effectiveShareCap,
      utilization5h,
      utilization7d,
      projectShareUsed,
      resets5hAtMs,
      resets7dAtMs,
      updatedAtMs,
      nextAvailableAtMs,
    };
  }
}

export class PoolDef implements AccountProvider {
  public readonly id: string;
  public readonly accounts: readonly AccountDef[];
  public readonly maxQuotaShareValue: number;
  public readonly strategyMode: PoolStrategy;
  public readonly reserveConfig: PoolReserveConfig | null;
  public readonly fallbackProvider: AccountProvider | null;

  public constructor(
    id: string,
    accounts: readonly AccountDef[],
    opts?: {
      maxQuotaShareValue?: number;
      strategyMode?: PoolStrategy;
      reserveConfig?: PoolReserveConfig | null;
      fallbackProvider?: AccountProvider | null;
    },
  ) {
    if (accounts.length === 0) {
      throw new Error(`Pool ${id} must contain at least one account`);
    }
    const share = opts?.maxQuotaShareValue ?? 1.0;
    if (share <= 0 || share > 1) {
      throw new Error(`Invalid maxQuotaShare ${share} for pool ${id}`);
    }
    this.id = id;
    this.accounts = accounts;
    this.maxQuotaShareValue = share;
    this.strategyMode = opts?.strategyMode ?? 'drain-soonest-expiring';
    this.reserveConfig = opts?.reserveConfig ?? null;
    this.fallbackProvider = opts?.fallbackProvider ?? null;
  }

  public maxQuotaShare(ratio: number): this {
    return new PoolDef(this.id, this.accounts, {
      maxQuotaShareValue: ratio,
      strategyMode: this.strategyMode,
      reserveConfig: this.reserveConfig,
      fallbackProvider: this.fallbackProvider,
    }) as this;
  }

  public strategy(mode: PoolStrategy): PoolDef {
    return new PoolDef(this.id, this.accounts, {
      maxQuotaShareValue: this.maxQuotaShareValue,
      strategyMode: mode,
      reserveConfig: this.reserveConfig,
      fallbackProvider: this.fallbackProvider,
    });
  }

  public reserve(config: PoolReserveConfig): PoolDef {
    return new PoolDef(this.id, this.accounts, {
      maxQuotaShareValue: this.maxQuotaShareValue,
      strategyMode: this.strategyMode,
      reserveConfig: config,
      fallbackProvider: this.fallbackProvider,
    });
  }

  public fallback(provider: AccountProvider): PoolDef {
    return new PoolDef(this.id, this.accounts, {
      maxQuotaShareValue: this.maxQuotaShareValue,
      strategyMode: this.strategyMode,
      reserveConfig: this.reserveConfig,
      fallbackProvider: provider,
    });
  }

  public async acquireAccount(store: HarnessStore): Promise<ResolvedAccount> {
    const nowMs = Date.now();
    const evaluations = await Promise.all(
      this.accounts.map((acct) => acct.evaluateEligibility(store, this.maxQuotaShareValue, nowMs)),
    );

    let eligible = evaluations.filter((e) => e.isEligible);

    if (this.reserveConfig && eligible.length > 0) {
      const { minFreeAccounts, maxBurstUtilization } = this.reserveConfig;
      const lowUsageAccounts = eligible.filter((e) => e.utilization5h < maxBurstUtilization);
      if (lowUsageAccounts.length > minFreeAccounts) {
        eligible = lowUsageAccounts;
      } else if (this.fallbackProvider) {
        eligible = [];
      }
    }

    if (eligible.length === 0) {
      if (this.fallbackProvider) {
        return this.fallbackProvider.acquireAccount(store);
      }
      const nextTimes = evaluations
        .map((e) => e.nextAvailableAtMs)
        .filter((v): v is number => v !== null);
      const soonest = nextTimes.length > 0 ? Math.min(...nextTimes) : null;
      throw new QuotaExhaustedError(this.id, soonest);
    }

    const sorted = [...eligible];
    switch (this.strategyMode) {
      case 'drain-soonest-expiring':
        sorted.sort((a, b) => {
          const rA = a.resets7dAtMs ?? Number.POSITIVE_INFINITY;
          const rB = b.resets7dAtMs ?? Number.POSITIVE_INFINITY;
          if (rA !== rB) return rA - rB;
          return a.utilization5h - b.utilization5h;
        });
        break;
      case 'least-used':
        sorted.sort((a, b) => {
          const uA = Math.max(a.utilization5h, a.projectShareUsed);
          const uB = Math.max(b.utilization5h, b.projectShareUsed);
          return uA - uB;
        });
        break;
      case 'priority':
        break;
      case 'round-robin':
        sorted.sort((a, b) => a.updatedAtMs - b.updatedAtMs);
        break;
    }

    const winner = sorted[0]!;
    store.upsertAccountQuota(winner.account.id, { updatedAtMs: Date.now() });
    return {
      accountId: winner.account.id,
      driver: winner.account.driver,
      maxQuotaShare: winner.effectiveShareCap,
    };
  }
}

export function parseRateLimitHeaders(
  headers: Record<string, string | undefined>,
  nowMs = Date.now(),
): Partial<QuotaSnapshot> {
  const result: {
    utilization5h?: number;
    utilization7d?: number;
    resets5hAtMs?: number | null;
    resets7dAtMs?: number | null;
    cooldownUntilMs?: number | null;
  } = {};

  const u5 = headers['anthropic-ratelimit-unified-5h-utilization'];
  if (u5 !== undefined && !Number.isNaN(Number(u5))) {
    result.utilization5h = Number(u5);
  }

  const u7 = headers['anthropic-ratelimit-unified-7d-utilization'];
  if (u7 !== undefined && !Number.isNaN(Number(u7))) {
    result.utilization7d = Number(u7);
  }

  const r5 = headers['anthropic-ratelimit-unified-5h-reset'];
  if (r5 !== undefined && !Number.isNaN(Number(r5))) {
    result.resets5hAtMs = Number(r5) * 1000;
  }

  const r7 = headers['anthropic-ratelimit-unified-7d-reset'];
  if (r7 !== undefined && !Number.isNaN(Number(r7))) {
    result.resets7dAtMs = Number(r7) * 1000;
  }

  const retryAfter = headers['retry-after'];
  if (retryAfter !== undefined && !Number.isNaN(Number(retryAfter))) {
    result.cooldownUntilMs = nowMs + Number(retryAfter) * 1000;
  }

  return result;
}
