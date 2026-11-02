import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Intent } from '../../dsl/roles.js';
import { GeminiCliDriver, GEMINI_WRITE_TOOLS, type GeminiApprovalMode } from '../../drivers/gemini-cli.js';
import type { CliSpawnBridge } from '../../drivers/cli-agent.js';
import type { GuardProtocol, Model, ModelDriver, ModelRequest, ModelResponse, SessionStatus } from '../../kernel/backends.js';
import type { Account, QuotaPartition } from '../../kernel/quota.js';
import type { EnvRef, JsonObject, Resolver } from '../../kernel/refs.js';
import { DEFAULT_RATE_LIMIT_COOLDOWN_MS, DEFAULT_UNAVAILABLE_COOLDOWN_MS, envelopeSchema, refusalOf, sessionIdFor, systemPrompt, tokensOf, unpack, userPrompt, windowsOf } from '../model-calls.js';
import { FinishedSessions } from '../sessions.js';

export const DEFAULT_INACTIVITY_TIMEOUT_MS = 10 * 60_000;

/** The approval mode the role's intents call for: tools run only when the role may run them. */
export function approvalModeFor(intents: readonly string[]): GeminiApprovalMode {
  if (intents.includes('run')) return 'yolo';
  if (intents.includes('edit')) return 'auto_edit';
  return 'plan';
}

/** Gemini CLI hook payloads as the kernel's guard events: writes through `write_file` or `replace`, and the agent's stop. */
export const geminiCliGuardProtocol: GuardProtocol = {
  parse(payload: JsonObject) {
    const event = String(payload.hook_event_name ?? '');
    if (event === 'AfterAgent') return { phase: 'stop', filePaths: [], raw: payload };
    if (event !== 'BeforeTool') return null;
    const input = (typeof payload.tool_input === 'object' && payload.tool_input !== null ? payload.tool_input : {}) as JsonObject;
    const filePath = GEMINI_WRITE_TOOLS.includes(String(payload.tool_name)) && typeof input.file_path === 'string' ? [input.file_path] : [];
    return { phase: 'pre-tool', filePaths: filePath, raw: payload };
  },
  formatDecision(_event, decision): JsonObject {
    return decision.allow ? {} : { decision: 'deny', reason: decision.reason ?? 'blocked by the harness' };
  },
};

export interface GeminiCliDriverOptions {
  readonly geminiBinary?: string;
  readonly env?: Record<string, string>;
  readonly spawnBridge?: CliSpawnBridge;
  /** Where `gemini` runs when the step has no workspace. */
  readonly workDir?: string;
  readonly inactivityTimeoutMs?: number;
  /** Where finished invocations are kept so `session` can find them after a crash. */
  readonly sessionDir?: string;
  readonly rateLimitCooldownMs?: number;
  readonly unavailableCooldownMs?: number;
}

/** The Gemini CLI behind the 0.4.0 `ModelDriver` contract: one `gemini -p` per call, resumed by session on a halt decision. */
export class GeminiCliModelDriver implements ModelDriver<'gemini-cli'> {
  public readonly name = 'gemini-cli';
  public readonly driver = 'gemini-cli' as const;
  public readonly hooks = true;
  public readonly guardProtocol = geminiCliGuardProtocol;
  private readonly inners = new Map<string, GeminiCliDriver>();
  private readonly sessions: FinishedSessions;

  public constructor(private readonly options: GeminiCliDriverOptions = {}) {
    this.sessions = new FinishedSessions(options.sessionDir ?? path.join(tmpdir(), 'harness-gemini-cli-sessions'));
  }

  public serves(account: Account): boolean {
    return account.driver === 'gemini-cli';
  }

  private inner(credential: EnvRef, resolver: Resolver): GeminiCliDriver {
    let inner = this.inners.get(credential.name);
    if (!inner) {
      inner = new GeminiCliDriver({
        apiKey: resolver.env(credential),
        ...(this.options.geminiBinary ? { geminiBinary: this.options.geminiBinary } : {}),
        ...(this.options.env ? { env: this.options.env } : {}),
        ...(this.options.spawnBridge ? { spawnBridge: this.options.spawnBridge } : {}),
      });
      this.inners.set(credential.name, inner);
    }
    return inner;
  }

  public async invoke(request: ModelRequest, resolver: Resolver): Promise<ModelResponse> {
    const cooldowns = {
      rateLimitCooldownMs: this.options.rateLimitCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS,
      unavailableCooldownMs: this.options.unavailableCooldownMs ?? DEFAULT_UNAVAILABLE_COOLDOWN_MS,
    };
    let result;
    try {
      result = await this.inner(request.account.credential, resolver).invoke({
        accountId: request.account.name,
        modelId: request.model,
        modelOptions: { approvalMode: approvalModeFor(request.role.intents as readonly Intent[]) },
        systemPrompt: systemPrompt(request),
        userPrompt: userPrompt(request),
        outputJsonSchema: envelopeSchema(request),
        workDir: request.workspacePath ?? this.options.workDir ?? process.cwd(),
        ...(request.guard
          ? {
              hookServerUrl: request.guard.endpoint,
              invocationId: request.guard.invocation,
              hookSubscriptions: { preToolIntents: request.guard.leases ? (['file-write'] as const) : [], stop: request.guard.stop },
            }
          : {}),
        runId: request.idempotencyKey.replace(/[^A-Za-z0-9_.-]/g, '_'),
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
    this.sessions.remember(request.idempotencyKey, response);
    return response;
  }

  public async session(idempotencyKey: string, _resolver: Resolver): Promise<SessionStatus> {
    return this.sessions.status(idempotencyKey);
  }
}

export const geminiCli = {
  /** A Gemini API key the CLI signs in with, drawing on the named quota partition. */
  account(name: string, options: { readonly apiKey: EnvRef; readonly quota: QuotaPartition }): Account<'gemini-cli'> {
    return { entity: 'account', name, driver: 'gemini-cli', credential: options.apiKey, quota: options.quota };
  },
  model(name: string, options: { readonly id: string }): Model<'gemini-cli'> {
    return { entity: 'model', name, id: options.id, driver: 'gemini-cli', batch: false };
  },
  driver(options?: GeminiCliDriverOptions): GeminiCliModelDriver {
    return new GeminiCliModelDriver(options);
  },
};
