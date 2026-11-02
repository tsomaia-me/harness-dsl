import { createHash } from 'node:crypto';
import type { ModelRequest, ModelResponse, StoredScope } from '../kernel/backends.js';
import { AccountRefusedError, type ObservedWindow } from '../kernel/quota.js';
import type { Json, JsonObject } from '../kernel/refs.js';
import { AccountUnavailableError, RateLimitedError } from '../drivers/errors.js';
import { ANTHROPIC_5H_WINDOW, ANTHROPIC_7D_WINDOW } from '../rate-limits/anthropic.js';
import type { QuotaPatch, TokenUsage } from '../types.js';

/** The windows that are usage allowances; every other reported window is a per-minute throttle (plan W3). */
export const ALLOWANCE_WINDOWS: ReadonlySet<string> = new Set([ANTHROPIC_5H_WINDOW, ANTHROPIC_7D_WINDOW]);

/** How long an account rests after a rate limit that names no reset, and after a failed login. */
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
export const DEFAULT_UNAVAILABLE_COOLDOWN_MS = 15 * 60_000;
/** How long a call may stay silent before the driver gives up on it. */
export const DEFAULT_INACTIVITY_TIMEOUT_MS = 10 * 60_000;
/** A refusal's detail on the partition is a reason, not a log: the provider's text is cut here. */
export const REFUSAL_DETAIL_LIMIT = 500;

export interface Cooldowns {
  readonly rateLimitCooldownMs: number;
  readonly unavailableCooldownMs: number;
}

const EMPTY_SCOPE: StoredScope = { kinds: [], roles: [], resources: [], facets: [] };

function nullable(schema: Json): JsonObject {
  return { anyOf: [schema, { type: 'null' }] };
}

/**
 * The JSON envelope every model call returns: the role's output under `result`, a raised halt under
 * `halt` when the step asks halts, and recorded memory under `recorded` when the role may record.
 */
export function envelopeSchema(request: ModelRequest): JsonObject {
  const properties: Record<string, Json> = { result: nullable(request.outputSchema) };
  if (request.halts.length > 0) {
    properties.halt = nullable({
      type: 'object',
      properties: { name: { type: 'string', enum: request.halts.map((halt) => halt.name) }, ask: { type: 'string' } },
      required: ['name', 'ask'],
      additionalProperties: false,
    });
  }
  if (request.role.intents.includes('record')) {
    properties.recorded = nullable({
      type: 'array',
      items: { type: 'object', properties: { journal: { type: 'string' }, text: { type: 'string' } }, required: ['journal', 'text'], additionalProperties: false },
    });
  }
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

export function systemPrompt(request: ModelRequest): string {
  const lines = [`You are the "${request.role.name}" seat.`];
  if (request.memory.length > 0) lines.push('', 'Remember:', ...request.memory.map((item) => `- ${item.text}`));
  lines.push('', 'Return your answer in the "result" field of the required JSON envelope.');
  if (request.halts.length > 0) {
    lines.push(`You may instead stop and ask for a decision: set "halt" to { "name": one of ${request.halts.map((halt) => `"${halt.name}"`).join(', ')}, "ask": your question } and "result" to null.`);
  }
  if (request.role.intents.includes('record')) lines.push('You may record what you learned for later calls in "recorded": a list of { "journal", "text" }.');
  return lines.join('\n');
}

export function userPrompt(request: ModelRequest): string {
  if (request.resume) return `Decision on "${request.resume.halt}": ${JSON.stringify(request.resume.decision)}\nContinue and return the result.`;
  return request.role.prompt || JSON.stringify(request.input);
}

interface Envelope {
  readonly result?: unknown;
  readonly halt?: { readonly name: string; readonly ask: string } | null;
  readonly recorded?: readonly { readonly journal: string; readonly text: string }[] | null;
}

export function unpack(output: unknown): Pick<ModelResponse, 'output' | 'halt' | 'recorded'> {
  const envelope = (typeof output === 'object' && output !== null ? output : {}) as Envelope;
  const halt = envelope.halt ? { halt: envelope.halt.name, ask: envelope.halt.ask } : undefined;
  const recorded = Array.isArray(envelope.recorded) ? envelope.recorded.map((entry) => ({ journal: entry.journal, text: entry.text, when: EMPTY_SCOPE })) : [];
  return { output: (envelope.result ?? null) as Json, ...(halt ? { halt } : {}), ...(recorded.length > 0 ? { recorded } : {}) };
}

export function tokensOf(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens;
}

/** The list price of a call whose charge differs from it: a prepaid plan's zero, a batch's discount. */
export function equivalentOf(usage: TokenUsage): Pick<ModelResponse, 'equivalentUsd'> {
  return usage.equivalentCostUsd !== null && usage.equivalentCostUsd !== usage.actualCostUsd ? { equivalentUsd: usage.equivalentCostUsd } : {};
}

export function windowsOf(patch: QuotaPatch | undefined): ObservedWindow[] {
  return (patch?.windows ?? []).flatMap((window) =>
    typeof window.utilization === 'number'
      ? [{ window: window.id, kind: ALLOWANCE_WINDOWS.has(window.id) ? ('allowance' as const) : ('throttle' as const), utilization: window.utilization, resetsAt: typeof window.resetsAtMs === 'number' ? new Date(window.resetsAtMs) : null }]
      : [],
  );
}

/** The 0.3.0 driver errors as the kernel's refusal, with the cooldown the provider named or the default. */
export function refusalOf(err: unknown, account: string, nowMs: number, cooldowns: Cooldowns): AccountRefusedError | undefined {
  if (err instanceof RateLimitedError) {
    const until = new Date(err.quota.cooldownUntilMs ?? nowMs + cooldowns.rateLimitCooldownMs);
    return new AccountRefusedError(account, 'rateLimited', until, err.message.slice(0, REFUSAL_DETAIL_LIMIT), windowsOf(err.quota));
  }
  if (err instanceof AccountUnavailableError) return new AccountRefusedError(account, 'unavailable', new Date(nowMs + cooldowns.unavailableCooldownMs), err.reason.slice(0, REFUSAL_DETAIL_LIMIT));
  return undefined;
}

/** A stable UUID for a step's idempotency key, so a rerun of the same step resumes its session. */
export function sessionIdFor(key: string): string {
  const hex = createHash('sha256').update(key).digest('hex');
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
