import type { Account, AccountState } from '../kernel/quota.js';

/** How far back a fold reads a partition: the longest provider window the kernel knows of. */
export const QUOTA_HORIZON_MS = 7 * 86_400_000;

interface Window {
  readonly utilization: number;
  readonly resetsAt: Date | null;
  readonly at: Date;
}

/**
 * Folds an account's partition events into the state a drain policy sees (design §5.10).
 * Utilization and cooldowns fold over every harness's events; the share folds this harness's
 * consumption against everyone's, scaled by the account's utilization, since the last observed
 * reset of the longest live window.
 */
export async function foldAccountState(account: Account, harness: string, shareCap: number, now: Date): Promise<AccountState> {
  const since = new Date(now.getTime() - QUOTA_HORIZON_MS);
  const windows = new Map<string, Window>();
  const resets = new Map<string, Date[]>();
  const consumed: { readonly harness: string; readonly tokens: number; readonly at: Date }[] = [];
  let cooldownUntil: Date | undefined;
  for await (const event of account.quota.read({ accounts: [account.name], since })) {
    if (event.type === 'consumed') {
      consumed.push(event);
    } else if (event.type === 'cooldown') {
      if (event.until > now && (!cooldownUntil || event.until > cooldownUntil)) cooldownUntil = event.until;
    } else {
      const previous = windows.get(event.window);
      if (!previous || event.at >= previous.at) windows.set(event.window, { utilization: event.utilization, resetsAt: event.resetsAt, at: event.at });
      if (event.resetsAt) resets.set(event.window, [...(resets.get(event.window) ?? []), event.resetsAt]);
    }
  }
  const live = [...windows.entries()].filter(([, window]) => window.resetsAt === null || window.resetsAt > now);
  const utilization = live.reduce((max, [, window]) => Math.max(max, window.utilization), 0);
  let windowResetsAt: Date | null = null;
  let shareWindow: string | undefined;
  let furthest: Date | undefined;
  for (const [name, window] of live) {
    if (!window.resetsAt) continue;
    if (!windowResetsAt || window.resetsAt < windowResetsAt) windowResetsAt = window.resetsAt;
    if (!furthest || window.resetsAt > furthest) {
      furthest = window.resetsAt;
      shareWindow = name;
    }
  }
  const lastReset = shareWindow
    ? (resets.get(shareWindow) ?? []).filter((reset) => reset <= now).sort((p, q) => q.getTime() - p.getTime())[0]
    : undefined;
  const from = lastReset ?? since;
  let mine = 0;
  let all = 0;
  for (const entry of consumed) {
    if (entry.at < from) continue;
    all += entry.tokens;
    if (entry.harness === harness) mine += entry.tokens;
  }
  const shareUsed = all > 0 ? (mine / all) * utilization : 0;
  return { account, utilization, shareUsed, shareCap, windowResetsAt, ...(cooldownUntil ? { cooldownUntil } : {}) };
}
