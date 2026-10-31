import type { HarnessStore } from './store.js';
import type {
  AccountProvider,
  Driver,
  QuotaPatch,
  QuotaPolicy,
  QuotaWindow,
  ResolvedAccount,
} from './types.js';

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

export class RateLimitedError extends Error {
  public readonly accountId: string;
  public readonly quota: QuotaPatch;

  public constructor(accountId: string, message: string, quota: QuotaPatch = {}) {
    super(message);
    this.name = 'RateLimitedError';
    this.accountId = accountId;
    this.quota = quota;
  }
}

export const DEFAULT_QUOTA_POLICY: QuotaPolicy = {
  thresholds: {},
  defaultThreshold: 0.95,
  probeStalenessMs: 60_000,
  tokenBudget: null,
  shareResetWindowId: null,
  defaultCooldownMs: 60_000,
};

function mergeQuotaPolicy<T extends Partial<QuotaPolicy>>(
  base: T,
  override: Partial<QuotaPolicy> | undefined,
): T {
  return {
    ...base,
    ...override,
    thresholds: { ...base.thresholds, ...override?.thresholds },
  };
}

export interface AccountEligibility {
  readonly account: AccountDef;
  readonly isEligible: boolean;
  readonly effectiveShareCap: number;
  readonly windows: readonly QuotaWindow[];
  readonly peakUtilization: number;
  readonly shareResetsAtMs: number | null;
  readonly projectShareUsed: number;
  readonly acquiredAtMs: number;
  readonly nextAvailableAtMs: number | null;
}

export class AccountDef implements AccountProvider {
  public readonly id: string;
  public readonly driver: Driver;
  public readonly maxQuotaShareValue: number;
  public readonly quotaPolicyOverride: Partial<QuotaPolicy>;
  public readonly effectiveQuotaPolicy: QuotaPolicy;

  public constructor(
    id: string,
    driver: Driver,
    maxQuotaShareValue = 1.0,
    quotaPolicyOverride: Partial<QuotaPolicy> = {},
  ) {
    if (maxQuotaShareValue <= 0 || maxQuotaShareValue > 1) {
      throw new Error(`Invalid maxQuotaShare ${maxQuotaShareValue} for account ${id}`);
    }
    this.id = id;
    this.driver = driver;
    this.maxQuotaShareValue = maxQuotaShareValue;
    this.quotaPolicyOverride = quotaPolicyOverride;
    this.effectiveQuotaPolicy = mergeQuotaPolicy(
      mergeQuotaPolicy(DEFAULT_QUOTA_POLICY, driver.quotaPolicy),
      quotaPolicyOverride,
    );
  }

  public maxQuotaShare(ratio: number): this {
    return new AccountDef(this.id, this.driver, ratio, this.quotaPolicyOverride) as this;
  }

  public quotaPolicy(override: Partial<QuotaPolicy>): AccountDef {
    return new AccountDef(
      this.id,
      this.driver,
      this.maxQuotaShareValue,
      mergeQuotaPolicy(this.quotaPolicyOverride, override),
    );
  }

  public async acquireAccount(store: HarnessStore): Promise<ResolvedAccount> {
    const eligible = await this.evaluateEligibility(store, 1.0, Date.now());
    if (!eligible.isEligible) {
      throw new QuotaExhaustedError(this.id, eligible.nextAvailableAtMs);
    }
    return this.resolve(store, eligible.effectiveShareCap);
  }

  public resolve(store: HarnessStore, effectiveShareCap: number): ResolvedAccount {
    store.upsertAccountQuota(this.id, { acquiredAtMs: Date.now() });
    return {
      accountId: this.id,
      driver: this.driver,
      maxQuotaShare: effectiveShareCap,
      quotaPolicy: this.effectiveQuotaPolicy,
    };
  }

  public async evaluateEligibility(
    store: HarnessStore,
    poolMaxQuotaShare: number,
    nowMs: number,
  ): Promise<AccountEligibility> {
    const policy = this.effectiveQuotaPolicy;
    store.registerQuotaPolicy(this.id, policy);
    let state = store.getAccountQuota(this.id);

    if (state) {
      const expiredWindows = state.windows.filter(
        (w) => w.resetsAtMs !== null && nowMs >= w.resetsAtMs,
      );
      const shareWindowExpired = expiredWindows.some((w) => w.id === policy.shareResetWindowId);
      const cooldownExpired = state.cooldownUntilMs !== null && nowMs >= state.cooldownUntilMs;
      if (expiredWindows.length > 0 || cooldownExpired) {
        store.upsertAccountQuota(this.id, {
          windows: expiredWindows.map((w) => ({ id: w.id, utilization: 0, resetsAtMs: null })),
          cooldownUntilMs: cooldownExpired ? null : undefined,
          ...(shareWindowExpired ? { projectShareUsed: 0, windowTokensUsed: 0 } : {}),
        });
        state = store.getAccountQuota(this.id);
      }
    }

    const probeIsStale =
      !state || state.probedAtMs === null || nowMs - state.probedAtMs > policy.probeStalenessMs;
    if (this.driver.probeQuota && probeIsStale) {
      const probed = await this.driver.probeQuota(this.id);
      const storedShareWindow = state?.windows.find((w) => w.id === policy.shareResetWindowId);
      const probedShareWindow = probed.windows?.find((w) => w.id === policy.shareResetWindowId);
      const shareWindowResetEarly =
        storedShareWindow !== undefined &&
        probedShareWindow?.utilization !== undefined &&
        probedShareWindow.utilization < storedShareWindow.utilization;
      store.upsertAccountQuota(this.id, {
        ...probed,
        probedAtMs: nowMs,
        ...(shareWindowResetEarly ? { projectShareUsed: 0, windowTokensUsed: 0 } : {}),
      });
      state = store.getAccountQuota(this.id);
    }

    const windows = state?.windows ?? [];
    const projectShareUsed = state?.projectShareUsed ?? 0;
    const cooldownUntilMs = state?.cooldownUntilMs ?? null;

    const overrideShare = store.getAccountShareOverride(this.id);
    const baseAccountCap = overrideShare ?? this.maxQuotaShareValue;
    const effectiveShareCap = Math.min(baseAccountCap, poolMaxQuotaShare);
    const inCooldown = cooldownUntilMs !== null && cooldownUntilMs > nowMs;
    const overShare = projectShareUsed >= effectiveShareCap;
    const overWindow = windows.some(
      (w) => w.utilization >= (policy.thresholds[w.id] ?? policy.defaultThreshold),
    );

    const candidates = [cooldownUntilMs, ...windows.map((w) => w.resetsAtMs)].filter(
      (v): v is number => v !== null && v > nowMs,
    );

    return {
      account: this,
      isEligible: !inCooldown && !overShare && !overWindow,
      effectiveShareCap,
      windows,
      peakUtilization: Math.max(0, ...windows.map((w) => w.utilization)),
      shareResetsAtMs:
        windows.find((w) => w.id === policy.shareResetWindowId)?.resetsAtMs ?? null,
      projectShareUsed,
      acquiredAtMs: state?.acquiredAtMs ?? 0,
      nextAvailableAtMs: candidates.length > 0 ? Math.min(...candidates) : null,
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
      const lowUsageAccounts = eligible.filter((e) => e.peakUtilization < maxBurstUtilization);
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
          const rA = a.shareResetsAtMs ?? Number.POSITIVE_INFINITY;
          const rB = b.shareResetsAtMs ?? Number.POSITIVE_INFINITY;
          if (rA !== rB) return rA - rB;
          return a.peakUtilization - b.peakUtilization;
        });
        break;
      case 'least-used':
        sorted.sort((a, b) => {
          const uA = Math.max(a.peakUtilization, a.projectShareUsed);
          const uB = Math.max(b.peakUtilization, b.projectShareUsed);
          return uA - uB;
        });
        break;
      case 'priority':
        break;
      case 'round-robin':
        sorted.sort((a, b) => a.acquiredAtMs - b.acquiredAtMs);
        break;
    }

    const winner = sorted[0]!;
    return winner.account.resolve(store, winner.effectiveShareCap);
  }
}
