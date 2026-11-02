import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { InactivityTimeoutError, killProcessGroupAndTree } from '../runner.js';
import type { Driver, DriverInvokeRequest, DriverInvokeResult, HookSubscriptions, PricingAdapter, QuotaPatch, QuotaPolicy, TokenUsage } from '../types.js';
import { AccountUnavailableError, RateLimitedError } from './errors.js';

export interface CliSpawnBridge {
  (args: readonly string[], env: Record<string, string>, cwd: string, onLine: (line: string) => void, inactivityTimeoutMs: number, signal: AbortSignal): Promise<{ exitCode: number; stderr: string }>;
}

/** What one agent run accumulates while its output streams by; the adapter fills it line by line. */
export interface CliAgentState {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  structuredOutput: unknown;
  rawText: string;
  reportedCostUsd: number | null;
  quota: QuotaPatch;
  rejectedUntilMs: number | null;
  rateLimited: boolean;
  authFailed: boolean;
  errorText: string;
  sessionId: string;
}

export interface PlacedSettings {
  readonly path: string;
  cleanup(): void;
}

/** One agent CLI: how to call it, what its stream says, and how it takes hook settings. */
export interface CliAgentAdapter {
  readonly name: string;
  readonly binary: string;
  readonly pricing: PricingAdapter;
  readonly quotaPolicy?: Partial<QuotaPolicy>;
  /** Variables stripped from the inherited environment when the adapter sets its own credential. */
  readonly stripInheritedEnv?: readonly string[];
  /** A prepaid plan: calls cost nothing more; the reported or estimated price is the equivalent. */
  readonly prepaid?: boolean;
  args(req: DriverInvokeRequest, sessionId: string, settingsPath?: string): string[];
  env(req: DriverInvokeRequest): Record<string, string>;
  /** One parsed JSON line of the agent's stream. */
  event(event: Record<string, any>, state: CliAgentState, req: DriverInvokeRequest): void;
  /** The run ended; read stderr for what the stream did not say. */
  ended?(exitCode: number, stderr: string, state: CliAgentState): void;
  /** Writes the hook settings the agent reads for this run and says where. */
  placeHookSettings?(req: DriverInvokeRequest, endpoint: string, subscriptions: HookSubscriptions): PlacedSettings;
}

export interface CliAgentDriverOptions {
  readonly binary?: string;
  readonly env?: Record<string, string>;
  readonly spawnBridge?: CliSpawnBridge;
}

function parseLooseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * The reusable half of an agent CLI driver: spawn in its own process group, a watchdog on silence,
 * stream parsing through the adapter, hook settings placed for the run, and the usage, quota and
 * refusal mapping. The Claude and Gemini CLIs are adapters on it.
 */
export class CliAgentDriver implements Driver {
  public readonly kind: string;
  public readonly binary: string;
  public readonly quotaPolicy: Partial<QuotaPolicy> | undefined;
  private readonly extraEnv: Record<string, string>;
  private readonly spawnBridge: CliSpawnBridge | undefined;

  public constructor(
    public readonly adapter: CliAgentAdapter,
    options: CliAgentDriverOptions = {},
  ) {
    this.kind = adapter.name;
    this.binary = options.binary ?? adapter.binary;
    this.quotaPolicy = adapter.quotaPolicy;
    this.extraEnv = options.env ?? {};
    this.spawnBridge = options.spawnBridge;
  }

  public async invoke(req: DriverInvokeRequest): Promise<DriverInvokeResult> {
    const sessionId = req.sessionId ?? randomUUID();
    const subscriptions = req.hookSubscriptions;
    const placed =
      req.hookServerUrl && req.invocationId && subscriptions && (subscriptions.preToolIntents.length > 0 || subscriptions.stop) && this.adapter.placeHookSettings
        ? this.adapter.placeHookSettings(req, req.hookServerUrl, subscriptions)
        : undefined;
    const state: CliAgentState = {
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      structuredOutput: undefined,
      rawText: '',
      reportedCostUsd: null,
      quota: {},
      rejectedUntilMs: null,
      rateLimited: false,
      authFailed: false,
      errorText: '',
      sessionId,
    };
    const onLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) return;
      try {
        this.adapter.event(JSON.parse(trimmed) as Record<string, any>, state, req);
      } catch (err) {
        void err;
      }
    };
    try {
      const bridge = this.spawnBridge ?? this.defaultSpawnBridge.bind(this);
      const env = { ...this.extraEnv, ...this.adapter.env(req) };
      const { exitCode, stderr } = await bridge(this.adapter.args(req, sessionId, placed?.path), env, req.workDir, onLine, req.inactivityTimeoutMs, req.signal);
      this.adapter.ended?.(exitCode, stderr, state);
      if (state.authFailed) throw new AccountUnavailableError(req.accountId, (state.errorText || stderr).trim());
      if (state.rateLimited) {
        throw new RateLimitedError(req.accountId, `Rate limit reached on account ${req.accountId}: ${state.errorText || stderr}`, {
          ...state.quota,
          ...(state.rejectedUntilMs !== null ? { cooldownUntilMs: state.rejectedUntilMs } : {}),
        });
      }
      if (state.structuredOutput === undefined) state.structuredOutput = parseLooseJson(state.rawText);
      if (exitCode !== 0 && state.structuredOutput === undefined) throw new Error(`${this.adapter.name} exited with code ${exitCode}: ${state.errorText || stderr || state.rawText}`);
      const counts = { inputTokens: state.inputTokens, cachedInputTokens: state.cachedInputTokens, cacheWriteTokens: state.cacheWriteTokens, outputTokens: state.outputTokens };
      const estimate = (req.pricing ?? this.adapter.pricing).estimate(req.modelId, counts, Date.now());
      const equivalent = state.reportedCostUsd ?? estimate;
      const usage: TokenUsage = { ...counts, actualCostUsd: this.adapter.prepaid ? 0 : equivalent, equivalentCostUsd: equivalent };
      return {
        structuredOutput: state.structuredOutput,
        rawText: state.rawText,
        sessionId: state.sessionId,
        usage,
        quotaHint: state.quota.windows ? state.quota : undefined,
      };
    } finally {
      placed?.cleanup();
    }
  }

  private defaultSpawnBridge(args: readonly string[], env: Record<string, string>, cwd: string, onLine: (line: string) => void, inactivityTimeoutMs: number, signal: AbortSignal): Promise<{ exitCode: number; stderr: string }> {
    return new Promise((resolve, reject) => {
      const baseEnv = { ...process.env };
      for (const name of this.adapter.stripInheritedEnv ?? []) if (!(name in this.extraEnv)) delete baseEnv[name];
      const child = spawn(this.binary, args, { cwd, env: { ...baseEnv, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let buffer = '';
      let stderr = '';
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const resetWatchdog = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () => {
          if (settled) return;
          settled = true;
          if (child.pid) await killProcessGroupAndTree(child.pid);
          reject(new InactivityTimeoutError(this.binary, inactivityTimeoutMs, buffer));
        }, inactivityTimeoutMs);
      };
      resetWatchdog();
      const onAbort = async () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (child.pid) await killProcessGroupAndTree(child.pid);
        reject(new Error(`${this.adapter.name} invocation aborted`));
      };
      if (signal.aborted) {
        void onAbort();
        return;
      }
      signal.addEventListener('abort', () => void onAbort(), { once: true });
      child.stdout?.on('data', (chunk: Buffer) => {
        resetWatchdog();
        buffer += chunk.toString('utf8');
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          onLine(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        resetWatchdog();
        stderr += chunk.toString('utf8');
      });
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(err);
      });
      child.on('close', async (code) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (buffer.trim().length > 0) onLine(buffer);
        if (child.pid) await killProcessGroupAndTree(child.pid);
        resolve({ exitCode: code ?? 1, stderr });
      });
    });
  }
}
