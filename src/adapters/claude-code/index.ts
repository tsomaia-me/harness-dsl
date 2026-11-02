import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Intent } from '../../dsl/roles.js';
import { ClaudeCliDriver, type ClaudeCliSpawnBridge } from '../../drivers/claude-cli.js';
import type { Model, ModelDriver, ModelRequest, ModelResponse, SessionStatus } from '../../kernel/backends.js';
import type { Account, QuotaPartition } from '../../kernel/quota.js';
import type { EnvRef, Resolver } from '../../kernel/refs.js';
import { parseWithDates, stringifyWithDates } from '../json-dates.js';
import { DEFAULT_RATE_LIMIT_COOLDOWN_MS, DEFAULT_UNAVAILABLE_COOLDOWN_MS, envelopeSchema, refusalOf, sessionIdFor, systemPrompt, tokensOf, unpack, userPrompt, windowsOf } from '../model-calls.js';

export const DEFAULT_INACTIVITY_TIMEOUT_MS = 10 * 60_000;

const TOOLS_BY_INTENT: Readonly<Record<Intent, readonly string[]>> = {
  read: ['Read', 'Glob', 'Grep'],
  edit: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
  run: ['Bash'],
  search: ['WebSearch'],
  browse: ['WebFetch'],
  halt: [],
  record: [],
};

export interface ClaudeCodeDriverOptions {
  readonly claudeBinary?: string;
  readonly env?: Record<string, string>;
  readonly spawnBridge?: ClaudeCliSpawnBridge;
  /** Where `claude -p` runs when the step has no workspace. */
  readonly workDir?: string;
  readonly inactivityTimeoutMs?: number;
  /** Where finished invocations are kept so `session` can find them after a crash. */
  readonly sessionDir?: string;
  readonly rateLimitCooldownMs?: number;
  readonly unavailableCooldownMs?: number;
}

/** The 0.3.0 Claude CLI driver behind the 0.4.0 `ModelDriver` contract: one `claude -p` per call, resumed by session on a halt decision. */
export class ClaudeCodeDriver implements ModelDriver<'claude-code'> {
  public readonly name = 'claude-code';
  public readonly driver = 'claude-code' as const;
  public readonly hooks = true;
  private readonly inners = new Map<string, ClaudeCliDriver>();
  private readonly sessionDir: string;

  public constructor(private readonly options: ClaudeCodeDriverOptions = {}) {
    this.sessionDir = options.sessionDir ?? path.join(tmpdir(), 'harness-claude-code-sessions');
    mkdirSync(this.sessionDir, { recursive: true });
  }

  public serves(account: Account): boolean {
    return account.driver === 'claude-code';
  }

  private inner(credential: EnvRef, resolver: Resolver): ClaudeCliDriver {
    let inner = this.inners.get(credential.name);
    if (!inner) {
      inner = new ClaudeCliDriver({
        oauthToken: resolver.env(credential),
        ...(this.options.claudeBinary ? { claudeBinary: this.options.claudeBinary } : {}),
        ...(this.options.env ? { env: this.options.env } : {}),
        ...(this.options.spawnBridge ? { spawnBridge: this.options.spawnBridge } : {}),
      });
      this.inners.set(credential.name, inner);
    }
    return inner;
  }

  private sessionFile(key: string): string {
    return path.join(this.sessionDir, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`);
  }

  public async invoke(request: ModelRequest, resolver: Resolver): Promise<ModelResponse> {
    const allowedTools = [...new Set(request.role.intents.flatMap((intent) => TOOLS_BY_INTENT[intent as Intent] ?? []))];
    const cooldowns = {
      rateLimitCooldownMs: this.options.rateLimitCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS,
      unavailableCooldownMs: this.options.unavailableCooldownMs ?? DEFAULT_UNAVAILABLE_COOLDOWN_MS,
    };
    let result;
    try {
      result = await this.inner(request.account.credential, resolver).invoke({
        accountId: request.account.name,
        modelId: request.model,
        modelOptions: {},
        systemPrompt: systemPrompt(request),
        userPrompt: userPrompt(request),
        outputJsonSchema: envelopeSchema(request),
        workDir: request.workspacePath ?? this.options.workDir ?? process.cwd(),
        ...(allowedTools.length > 0 ? { allowedTools } : {}),
        runId: request.idempotencyKey,
        stepName: request.seat,
        sessionId: request.resume?.sessionId ?? sessionIdFor(request.idempotencyKey),
        resumeSession: request.resume !== undefined,
        inactivityTimeoutMs: this.options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS,
        signal: new AbortController().signal,
      });
    } catch (err) {
      throw refusalOf(err, request.account.name, Date.now(), cooldowns) ?? err;
    }
    const windows = windowsOf(result.quotaHint);
    const response: ModelResponse = {
      ...unpack(result.structuredOutput),
      costUsd: result.usage.actualCostUsd,
      tokens: tokensOf(result.usage),
      sessionId: result.sessionId,
      ...(windows.length > 0 ? { windows } : {}),
    };
    writeFileSync(this.sessionFile(request.idempotencyKey), stringifyWithDates(response), 'utf8');
    return response;
  }

  public async session(idempotencyKey: string, _resolver: Resolver): Promise<SessionStatus> {
    const file = this.sessionFile(idempotencyKey);
    if (!existsSync(file)) return { status: 'lost' };
    return { status: 'finished', response: parseWithDates<ModelResponse>(readFileSync(file, 'utf8')) };
  }
}

export const claudeCode = {
  /** A Claude subscription signed in through an OAuth token, drawing on the named quota partition. */
  subscription(name: string, options: { readonly token: EnvRef; readonly quota: QuotaPartition }): Account<'claude-code'> {
    return { entity: 'account', name, driver: 'claude-code', credential: options.token, quota: options.quota };
  },
  model(name: string, options: { readonly id: string }): Model<'claude-code'> {
    return { entity: 'model', name, id: options.id, driver: 'claude-code', batch: false };
  },
  driver(options?: ClaudeCodeDriverOptions): ClaudeCodeDriver {
    return new ClaudeCodeDriver(options);
  },
};
