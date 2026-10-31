import type { QuotaPatch, QuotaWindowPatch } from '../types.js';

export type HeaderRecord = Readonly<Record<string, string | undefined>>;

export function lowercaseHeaders(headers: HeaderRecord): Record<string, string> {
  const lowered: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) lowered[name.toLowerCase()] = value;
  }
  return lowered;
}

export function numericHeader(headers: Record<string, string>, name: string): number | undefined {
  const raw = headers[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isNaN(value) ? undefined : value;
}

export function remainingWindow(
  id: string,
  limit: number | undefined,
  remaining: number | undefined,
  resetsAtMs: number | undefined,
): QuotaWindowPatch | null {
  if (limit === undefined || remaining === undefined || limit <= 0) return null;
  return {
    id,
    utilization: Math.min(1, Math.max(0, (limit - remaining) / limit)),
    ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
  };
}

export function retryAfterCooldown(headers: Record<string, string>, nowMs: number): number | undefined {
  const raw = headers['retry-after'];
  if (raw === undefined) return undefined;
  const seconds = numericHeader(headers, 'retry-after');
  if (seconds !== undefined) return nowMs + seconds * 1000;
  const dateMs = Date.parse(raw);
  return Number.isNaN(dateMs) ? undefined : dateMs;
}

export function quotaPatch(
  windows: readonly (QuotaWindowPatch | null)[],
  cooldownUntilMs: number | undefined,
): QuotaPatch {
  const present = windows.filter((w): w is QuotaWindowPatch => w !== null);
  return {
    ...(present.length > 0 ? { windows: present } : {}),
    ...(cooldownUntilMs !== undefined ? { cooldownUntilMs } : {}),
  };
}
