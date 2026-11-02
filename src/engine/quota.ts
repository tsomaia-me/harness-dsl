import type { Account, AccountState } from '../kernel/quota.js';

/** How far back a fold reads a partition: the longest provider window the kernel knows of. */
export const QUOTA_HORIZON_MS = 7 * 86_400_000;

interface Window {
  readonly utilization: number;
  readonly resetsAt: Date | null;
  readonly at: Date;
  readonly throttle: boolean;
}

interface Observation {
  readonly harness: string;
  readonly utilization: number;
  readonly at: Date;
}

/**
 * Folds an account's partition events into the state a drain policy sees (design §5.10, plan W3 and W4).
 * Utilization is the highest live allowance window, over every harness's events. A cooldown is the
 * latest one anyone recorded, or a saturated throttle window's reset. The share is the utilization
 * rise of the longest allowance window observed across this harness's own calls since that window's
 * last reset: each observation is charged the rise over the previous observation by anyone.
 */
export async function foldAccountState(account: Account, harness: string, shareCap: number, now: Date): Promise<AccountState> {
  const since = new Date(now.getTime() - QUOTA_HORIZON_MS);
  const windows = new Map<string, Window>();
  const observations = new Map<string, Observation[]>();
  const resets = new Map<string, Date[]>();
  let cooldownUntil: Date | undefined;
  const coolDown = (until: Date) => {
    if (until > now && (!cooldownUntil || until > cooldownUntil)) cooldownUntil = until;
  };
  for await (const event of account.quota.read({ accounts: [account.name], since })) {
    if (event.type === 'cooldown') {
      coolDown(event.until);
    } else if (event.type === 'windowObserved') {
      const previous = windows.get(event.window);
      if (!previous || event.at >= previous.at) windows.set(event.window, { utilization: event.utilization, resetsAt: event.resetsAt, at: event.at, throttle: event.kind === 'throttle' });
      observations.set(event.window, [...(observations.get(event.window) ?? []), { harness: event.harness, utilization: event.utilization, at: event.at }]);
      if (event.resetsAt) resets.set(event.window, [...(resets.get(event.window) ?? []), event.resetsAt]);
    }
  }
  const live = [...windows.entries()].filter(([, window]) => window.resetsAt === null || window.resetsAt > now);
  for (const [, window] of live) {
    if (window.throttle && window.utilization >= 1 && window.resetsAt) coolDown(window.resetsAt);
  }
  const allowance = live.filter(([, window]) => !window.throttle);
  const utilization = allowance.reduce((max, [, window]) => Math.max(max, window.utilization), 0);
  let windowResetsAt: Date | null = null;
  let shareWindow: string | undefined;
  let furthest: Date | undefined;
  for (const [name, window] of allowance) {
    if (!window.resetsAt) continue;
    if (!windowResetsAt || window.resetsAt < windowResetsAt) windowResetsAt = window.resetsAt;
    if (!furthest || window.resetsAt > furthest) {
      furthest = window.resetsAt;
      shareWindow = name;
    }
  }
  let shareUsed = 0;
  if (shareWindow) {
    const lastReset = (resets.get(shareWindow) ?? []).filter((reset) => reset <= now).sort((p, q) => q.getTime() - p.getTime())[0];
    const from = lastReset ?? since;
    let previous = 0;
    for (const observation of (observations.get(shareWindow) ?? []).filter((candidate) => candidate.at >= from).sort((p, q) => p.at.getTime() - q.at.getTime())) {
      const rise = Math.max(0, observation.utilization - previous);
      if (observation.harness === harness) shareUsed += rise;
      previous = observation.utilization;
    }
  }
  return { account, utilization, shareUsed, shareCap, windowResetsAt, ...(cooldownUntil ? { cooldownUntil } : {}) };
}
