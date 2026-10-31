import type { QuotaPatch, QuotaWindowPatch } from '../types.js';
import { ANTHROPIC_5H_WINDOW, ANTHROPIC_7D_WINDOW } from './anthropic.js';

const UNIFIED_WINDOW_IDS: Readonly<Record<string, string>> = {
  five_hour: ANTHROPIC_5H_WINDOW,
  seven_day: ANTHROPIC_7D_WINDOW,
};

function unifiedWindowId(rateLimitType: string): string {
  return UNIFIED_WINDOW_IDS[rateLimitType] ?? `anthropic:${rateLimitType}`;
}

export interface ClaudeCliRateLimitEvent {
  readonly quota: QuotaPatch;
  readonly rejectedUntilMs: number | null;
}

export function readClaudeCliRateLimitEvent(event: Record<string, any>): ClaudeCliRateLimitEvent | null {
  if (event.type !== 'rate_limit_event' || typeof event.rate_limit_info !== 'object') return null;
  const info = event.rate_limit_info as Record<string, any>;
  const windows: QuotaWindowPatch[] = Object.entries(
    (info.unifiedWindows ?? {}) as Record<string, { utilization?: unknown; resetsAt?: unknown }>,
  ).map(([type, window]) => ({
    id: unifiedWindowId(type),
    ...(typeof window.utilization === 'number' ? { utilization: window.utilization } : {}),
    ...(typeof window.resetsAt === 'number' ? { resetsAtMs: window.resetsAt * 1000 } : {}),
  }));
  return {
    quota: windows.length > 0 ? { windows } : {},
    rejectedUntilMs:
      info.status === 'rejected' && typeof info.resetsAt === 'number' ? info.resetsAt * 1000 : null,
  };
}

export const CLAUDE_CLI_RATE_LIMIT_TEXT = /\brate[ -]?limit(?:ed|s)?\b|\busage limit\b|\b429\b/i;

export function parseRateLimitResetFromMessage(msg: string, nowMs = Date.now()): number | null {
  const isoMatch = msg.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/);
  if (isoMatch) {
    const parsed = Date.parse(isoMatch[0]);
    if (!Number.isNaN(parsed) && parsed > nowMs) {
      return parsed;
    }
  }

  const relMatch = msg.match(
    /(?:reset(?:s| at| in)?|retry(?: after| in)?|in)\s+(\d+)\s*(s|sec|seconds|m|min|minutes|h|hr|hours)\b/i,
  );
  if (relMatch) {
    const amount = Number(relMatch[1]);
    const unit = relMatch[2]!.toLowerCase();
    const mult = unit.startsWith('h') ? 3_600_000 : unit.startsWith('m') ? 60_000 : 1_000;
    if (amount > 0) {
      return nowMs + amount * mult;
    }
  }

  const epochMatch = msg.match(/\b(1[789]\d{8})\b/);
  if (epochMatch) {
    const epochMs = Number(epochMatch[1]) * 1000;
    if (epochMs > nowMs) {
      return epochMs;
    }
  }

  return null;
}
