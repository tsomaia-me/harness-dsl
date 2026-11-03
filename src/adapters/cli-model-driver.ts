import type { CliAgentDriver, CliSpawnBridge } from '../drivers/cli-agent.js';
import type { GuardProtocol, ModelDriver, ModelRequest, ModelResponse, SessionStatus } from '../kernel/backends.js';
import type { Account } from '../kernel/quota.js';
import type { Resolver } from '../kernel/refs.js';
import { credentialKey, DEFAULT_INACTIVITY_TIMEOUT_MS, DEFAULT_RATE_LIMIT_COOLDOWN_MS, DEFAULT_UNAVAILABLE_COOLDOWN_MS, envelopeSchema, equivalentOf, refusalOf, sessionIdFor, systemPrompt, tokensOf, unpack, userPrompt, windowsOf } from './model-calls.js';
import { FinishedSessions } from './sessions.js';

export interface CliModelDriverOptions {
  readonly env?: Record<string, string>;
  readonly spawnBridge?: CliSpawnBridge;
  /** Where the agent runs when the step has no workspace. */
  readonly workDir?: string;
  readonly inactivityTimeoutMs?: number;
  /** Where finished invocations and running markers are kept so `session` can answer after a crash. */
  readonly sessionDir?: string;
  readonly rateLimitCooldownMs?: number;
  readonly unavailableCooldownMs?: number;
}

/**
 * An agent CLI behind the `ModelDriver` contract: one run per call in the step's workspace, the
 * role's intents as the agent's permissions, a halt decision resumed by session, the response kept
 * for `session`, and the agent's pid kept while it runs. The Claude and Gemini CLIs extend it.
 */
export abstract class CliModelDriver<D extends string> implements ModelDriver<D> {
  public readonly name: string;
  public readonly hooks = true;
  private readonly inners = new Map<string, CliAgentDriver>();
  private readonly sessions: FinishedSessions;

  protected constructor(
    public readonly driver: D,
    public readonly guardProtocol: GuardProtocol,
    protected readonly options: CliModelDriverOptions,
    defaultSessionDir: string,
  ) {
    this.name = driver;
    this.sessions = new FinishedSessions(options.sessionDir ?? defaultSessionDir);
  }

  /** The agent driver for one account's sign-in. */
  protected abstract createInner(account: Account, resolver: Resolver): CliAgentDriver;

  /** What tells one inner driver from another: the credential, and whatever else the sign-in depends on. */
  protected innerKey(account: Account): string {
    return credentialKey(account.credential);
  }

  protected modelOptions(_request: ModelRequest): Record<string, unknown> {
    return {};
  }

  protected allowedTools(_request: ModelRequest): readonly string[] {
    return [];
  }

  public serves(account: Account): boolean {
    return account.driver === this.driver;
  }

  private inner(account: Account, resolver: Resolver): CliAgentDriver {
    const key = this.innerKey(account);
    let inner = this.inners.get(key);
    if (!inner) {
      inner = this.createInner(account, resolver);
      this.inners.set(key, inner);
    }
    return inner;
  }

  public async invoke(request: ModelRequest, resolver: Resolver): Promise<ModelResponse> {
    const key = request.idempotencyKey;
    const allowedTools = this.allowedTools(request);
    const cooldowns = {
      rateLimitCooldownMs: this.options.rateLimitCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS,
      unavailableCooldownMs: this.options.unavailableCooldownMs ?? DEFAULT_UNAVAILABLE_COOLDOWN_MS,
    };
    let result;
    try {
      result = await this.inner(request.account, resolver).invoke({
        accountId: request.account.name,
        modelId: request.model,
        modelOptions: this.modelOptions(request),
        systemPrompt: systemPrompt(request),
        userPrompt: userPrompt(request),
        outputJsonSchema: envelopeSchema(request),
        workDir: request.workspacePath ?? this.options.workDir ?? process.cwd(),
        ...(allowedTools.length > 0 ? { allowedTools } : {}),
        ...(request.guard
          ? {
              hookServerUrl: request.guard.endpoint,
              invocationId: request.guard.invocation,
              hookSubscriptions: { preToolIntents: request.guard.leases ? (['file-write'] as const) : [], stop: request.guard.stop },
            }
          : {}),
        runId: key.replace(/[^A-Za-z0-9_.-]/g, '_'),
        stepName: request.seat,
        sessionId: request.resume?.sessionId ?? sessionIdFor(key),
        resumeSession: request.resume !== undefined,
        inactivityTimeoutMs: this.options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS,
        signal: request.cancel ?? new AbortController().signal,
        onSpawn: (pid) => this.sessions.running(key, pid),
      });
    } catch (err) {
      this.sessions.release(key);
      throw refusalOf(err, request.account.name, Date.now(), cooldowns) ?? err;
    }
    const windows = windowsOf(result.quotaHint);
    const response: ModelResponse = {
      ...unpack(result.structuredOutput),
      costUsd: result.usage.actualCostUsd,
      ...equivalentOf(result.usage),
      tokens: tokensOf(result.usage),
      sessionId: result.sessionId,
      ...(windows.length > 0 ? { windows } : {}),
    };
    this.sessions.remember(key, response);
    return response;
  }

  public async session(idempotencyKey: string, _resolver: Resolver): Promise<SessionStatus> {
    return this.sessions.status(idempotencyKey);
  }
}
