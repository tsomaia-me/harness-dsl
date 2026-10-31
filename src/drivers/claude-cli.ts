import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { RateLimitedError } from '../quota.js';
import {
  CLAUDE_CLI_RATE_LIMIT_TEXT,
  parseRateLimitResetFromMessage,
  readClaudeCliRateLimitEvent,
} from '../rate-limits/claude-cli.js';
import { InactivityTimeoutError, killProcessGroupAndTree } from '../runner.js';
import type {
  Driver,
  DriverInvokeRequest,
  DriverInvokeResult,
  QuotaPatch,
  QuotaPolicy,
  TokenUsage,
} from '../types.js';

export const CLAUDE_SUBSCRIPTION_QUOTA_POLICY: Partial<QuotaPolicy> = {
  thresholds: { 'anthropic:5h': 0.95, 'anthropic:7d': 0.98 },
  tokenBudget: 5_000_000,
  shareResetWindowId: 'anthropic:7d',
};

export interface ClaudeCliSpawnBridge {
  (
    args: readonly string[],
    env: Record<string, string>,
    cwd: string,
    onLine: (line: string) => void,
    inactivityTimeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ exitCode: number; stderr: string }>;
}

export interface ClaudeCliDriverOptions {
  readonly configDir?: string;
  readonly claudeBinary?: string;
  readonly env?: Record<string, string>;
  readonly spawnBridge?: ClaudeCliSpawnBridge;
  readonly probeQuota?: (accountId: string) => Promise<QuotaPatch>;
}

export function estimateEquivalentUsd(
  modelId: string,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
): number {
  const lower = modelId.toLowerCase();
  let inRatePerM = 3.0;
  let outRatePerM = 15.0;
  if (lower.includes('opus')) {
    inRatePerM = 15.0;
    outRatePerM = 75.0;
  } else if (lower.includes('haiku')) {
    inRatePerM = 0.8;
    outRatePerM = 4.0;
  }
  const uncachedIn = Math.max(0, inputTokens - cachedInputTokens);
  const cachedCost = (cachedInputTokens / 1_000_000) * (inRatePerM * 0.1);
  const inputCost = (uncachedIn / 1_000_000) * inRatePerM;
  const outputCost = (outputTokens / 1_000_000) * outRatePerM;
  return Number((inputCost + cachedCost + outputCost).toFixed(6));
}

function expandHome(filepath: string): string {
  if (filepath.startsWith('~/')) {
    return path.join(homedir(), filepath.slice(2));
  }
  return filepath;
}

const HANDOFF_JSON_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    remainingWork: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'remainingWork'],
  additionalProperties: false,
};

export class ClaudeCliDriver implements Driver {
  public readonly kind = 'claude-cli' as const;
  public readonly configDir?: string;
  public readonly claudeBinary: string;
  private readonly extraEnv: Record<string, string>;
  private readonly spawnBridge?: ClaudeCliSpawnBridge;
  public readonly probeQuota?: (accountId: string) => Promise<QuotaPatch>;
  public readonly quotaPolicy = CLAUDE_SUBSCRIPTION_QUOTA_POLICY;

  public constructor(opts?: ClaudeCliDriverOptions) {
    this.configDir = opts?.configDir ? expandHome(opts.configDir) : undefined;
    this.claudeBinary = opts?.claudeBinary ?? 'claude';
    this.extraEnv = opts?.env ?? {};
    this.spawnBridge = opts?.spawnBridge;
    this.probeQuota = opts?.probeQuota;
  }

  public buildHookSettingsJson(
    hookServerUrl: string,
    runId: string,
    hookTypes: readonly ('PreToolUse' | 'PostToolUse' | 'Stop')[],
  ): Record<string, unknown> {
    const hooksObj: Record<string, unknown[]> = {};
    for (const hookType of hookTypes) {
      const endpoint = `${hookServerUrl.replace(/\/$/, '')}/internal/hook?event=${hookType}&runId=${encodeURIComponent(runId)}`;
      const cmd = `curl -sS -X POST "${endpoint}" -H "content-type: application/json" --data-binary @-`;
      if (hookType === 'PreToolUse') {
        hooksObj.PreToolUse = [
          {
            matcher: 'Edit|Write|MultiEdit',
            hooks: [{ type: 'command', command: cmd }],
          },
        ];
      } else {
        hooksObj[hookType] = [
          {
            hooks: [{ type: 'command', command: cmd }],
          },
        ];
      }
    }
    return { hooks: hooksObj };
  }

  public buildCliArgs(
    req: DriverInvokeRequest,
    sessionId: string,
    settingsFilePath?: string,
    mcpConfigFilePath?: string,
  ): string[] {
    const sessionFlags = req.resumeSession
      ? ['--resume', sessionId]
      : ['--session-id', sessionId];

    const args: string[] = [
      '-p',
      '--model',
      req.modelId,
      ...sessionFlags,
      '--output-format',
      'stream-json',
      '--verbose',
      '--json-schema',
      JSON.stringify(req.outputJsonSchema),
    ];

    if (req.systemPrompt.trim().length > 0 && !req.resumeSession) {
      args.push('--append-system-prompt', req.systemPrompt);
    }

    const customToolNames = req.customTools
      ? Array.from(req.customTools.keys()).map((name) => `mcp__harness__${name}`)
      : [];
    const combinedAllowedTools = [...(req.allowedTools ?? []), ...customToolNames];

    if (combinedAllowedTools.length > 0) {
      args.push('--allowedTools', combinedAllowedTools.join(','));
    }

    if (settingsFilePath) {
      args.push('--settings', settingsFilePath);
    }

    if (mcpConfigFilePath) {
      args.push('--mcp-config', mcpConfigFilePath);
    }

    args.push('--strict-mcp-config', req.userPrompt);
    return args;
  }

  public async invoke(req: DriverInvokeRequest): Promise<DriverInvokeResult> {
    const sessionId = req.sessionId ?? randomUUID();
    let settingsFilePath: string | undefined;
    let mcpConfigFilePath: string | undefined;

    if (req.hookServerUrl && req.hookTypes && req.hookTypes.length > 0) {
      const settingsDir = path.join(tmpdir(), 'harness-cli-settings');
      mkdirSync(settingsDir, { recursive: true });
      settingsFilePath = path.join(
        settingsDir,
        `settings-${req.runId}-${req.stepName}-${randomUUID()}.json`,
      );
      const settingsPayload = this.buildHookSettingsJson(
        req.hookServerUrl,
        req.runId,
        req.hookTypes,
      );
      writeFileSync(settingsFilePath, JSON.stringify(settingsPayload, null, 2), 'utf8');
    }

    if (req.hookServerUrl && req.customTools && req.customTools.size > 0) {
      const settingsDir = path.join(tmpdir(), 'harness-cli-settings');
      mkdirSync(settingsDir, { recursive: true });
      mcpConfigFilePath = path.join(
        settingsDir,
        `mcp-${req.runId}-${req.stepName}-${randomUUID()}.json`,
      );
      const mcpPayload = {
        mcpServers: {
          harness: {
            type: 'http',
            url: `${req.hookServerUrl.replace(/\/$/, '')}/mcp`,
          },
        },
      };
      writeFileSync(mcpConfigFilePath, JSON.stringify(mcpPayload, null, 2), 'utf8');
    }

    const args = this.buildCliArgs(req, sessionId, settingsFilePath, mcpConfigFilePath);
    const env: Record<string, string> = {
      ...this.extraEnv,
    };
    if (this.configDir) {
      if (this.configDir.startsWith('sk-ant-')) {
        env.CLAUDE_CODE_OAUTH_TOKEN = this.configDir;
      } else if (this.configDir !== path.join(homedir(), '.claude')) {
        env.CLAUDE_CONFIG_DIR = this.configDir;
      }
    }

    let inputTokens = 0;
    let cachedInputTokens = 0;
    let outputTokens = 0;
    let structuredOutput: unknown = undefined;
    let rawText = '';
    let handoffTriggered = false;
    let latestQuota: QuotaPatch = {};
    let rejectedUntilMs: number | null = null;
    let turnRateLimited = false;
    let errorText = '';

    const onLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) return;
      try {
        const event = JSON.parse(trimmed) as Record<string, any>;
        const usage = event.message?.usage ?? event.usage;
        if (usage && typeof usage === 'object') {
          const inTok = Number(usage.input_tokens ?? 0);
          const cacheCreate = Number(usage.cache_creation_input_tokens ?? 0);
          const cacheRead = Number(usage.cache_read_input_tokens ?? 0);
          const outTok = Number(usage.output_tokens ?? 0);
          inputTokens = Math.max(inputTokens, inTok + cacheCreate + cacheRead);
          cachedInputTokens = Math.max(cachedInputTokens, cacheRead);
          outputTokens = Math.max(outputTokens, outTok);

          const totalContext = inTok + cacheCreate + cacheRead + outTok;
          if (req.maxContextTokens && totalContext >= req.maxContextTokens - 30_000) {
            handoffTriggered = true;
          }
        }

        if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
          for (const block of event.message.content) {
            if (block.type === 'text' && typeof block.text === 'string') {
              rawText = block.text;
            }
          }
        }

        if (event.type === 'result') {
          if (event.structured_output !== undefined) {
            structuredOutput = event.structured_output;
          } else if (typeof event.result === 'string') {
            rawText = event.result;
            try {
              structuredOutput = JSON.parse(event.result);
            } catch (err) {
              void err;
            }
          }
        }

        const rateLimitEvent = readClaudeCliRateLimitEvent(event);
        if (rateLimitEvent) {
          latestQuota = rateLimitEvent.quota;
          rejectedUntilMs = rateLimitEvent.rejectedUntilMs;
        }

        if (event.type === 'error' || event.is_error === true) {
          errorText = String(event.error?.message ?? event.result ?? '');
          if (event.api_error_status === 429 || CLAUDE_CLI_RATE_LIMIT_TEXT.test(errorText)) {
            turnRateLimited = true;
          }
        }
      } catch (err) {
        void err;
      }
    };

    try {
      const bridge = this.spawnBridge ?? this.defaultSpawnBridge.bind(this);
      const { exitCode, stderr } = await bridge(
        args,
        env,
        req.workDir,
        onLine,
        req.inactivityTimeoutMs,
        req.signal,
      );

      const failedWithRateLimitText =
        exitCode !== 0 && structuredOutput === undefined && CLAUDE_CLI_RATE_LIMIT_TEXT.test(stderr);
      if (turnRateLimited || failedWithRateLimitText) {
        const detail = errorText || stderr;
        const cooldownUntilMs = rejectedUntilMs ?? parseRateLimitResetFromMessage(detail);
        throw new RateLimitedError(
          req.accountId,
          `Rate limit reached on account ${req.accountId}: ${detail}`,
          { ...latestQuota, ...(cooldownUntilMs !== null ? { cooldownUntilMs } : {}) },
        );
      }

      if (exitCode !== 0 && structuredOutput === undefined) {
        throw new Error(`claude CLI exited with code ${exitCode}: ${stderr || rawText}`);
      }

      if (structuredOutput === undefined && rawText.trim().startsWith('{')) {
        structuredOutput = JSON.parse(rawText.trim());
      }

      const isIncompleteOutput =
        structuredOutput === undefined ||
        (typeof structuredOutput === 'object' &&
          structuredOutput !== null &&
          (structuredOutput as Record<string, unknown>).done === false);

      let handoffRequested: { summary: string; remainingWork: readonly string[] } | undefined;

      if (handoffTriggered && isIncompleteOutput) {
        let extractedHandoff: { summary?: string; remainingWork?: string[] } | undefined;
        const handoffArgs = [
          '-p',
          '--model',
          req.modelId,
          '--resume',
          sessionId,
          '--output-format',
          'stream-json',
          '--verbose',
          '--json-schema',
          JSON.stringify(HANDOFF_JSON_SCHEMA),
          '--strict-mcp-config',
          'Context ceiling reached. Summarize work completed so far and list remaining criteria as JSON { summary, remainingWork }.',
        ];
        try {
          await bridge(
            handoffArgs,
            env,
            req.workDir,
            (line) => {
              const trimmed = line.trim();
              if (!trimmed.startsWith('{')) return;
              try {
                const ev = JSON.parse(trimmed) as Record<string, any>;
                if (ev.type === 'result' && ev.structured_output && typeof ev.structured_output === 'object') {
                  extractedHandoff = ev.structured_output;
                }
              } catch (err) {
                void err;
              }
            },
            req.inactivityTimeoutMs,
            req.signal,
          );
        } catch (err) {
          void err;
        }

        handoffRequested = {
          summary:
            typeof extractedHandoff?.summary === 'string' && extractedHandoff.summary.length > 0
              ? extractedHandoff.summary
              : rawText.slice(-1000) || 'Context ceiling reached',
          remainingWork:
            Array.isArray(extractedHandoff?.remainingWork) &&
            extractedHandoff.remainingWork.length > 0
              ? extractedHandoff.remainingWork.map(String)
              : ['Continue remaining criteria in fresh session'],
        };
      }

      const usage: TokenUsage = {
        inputTokens,
        cachedInputTokens,
        outputTokens,
        actualCostUsd: 0,
        equivalentCostUsd: estimateEquivalentUsd(
          req.modelId,
          inputTokens,
          cachedInputTokens,
          outputTokens,
        ),
      };

      return {
        structuredOutput,
        rawText,
        sessionId,
        usage,
        handoffRequested,
        quotaHint: latestQuota.windows ? latestQuota : undefined,
      };
    } finally {
      if (settingsFilePath) {
        rmSync(settingsFilePath, { force: true });
      }
      if (mcpConfigFilePath) {
        rmSync(mcpConfigFilePath, { force: true });
      }
    }
  }

  private defaultSpawnBridge(
    args: readonly string[],
    env: Record<string, string>,
    cwd: string,
    onLine: (line: string) => void,
    inactivityTimeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ exitCode: number; stderr: string }> {
    return new Promise((resolve, reject) => {
      const baseEnv = { ...process.env };
      if (
        (this.configDir || env.CLAUDE_CONFIG_DIR || env.CLAUDE_CODE_OAUTH_TOKEN) &&
        !this.extraEnv.ANTHROPIC_API_KEY
      ) {
        delete baseEnv.ANTHROPIC_API_KEY;
      }
      const child = spawn(this.claudeBinary, args, {
        cwd,
        env: { ...baseEnv, ...env },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

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
          reject(new InactivityTimeoutError('claude -p', inactivityTimeoutMs, buffer));
        }, inactivityTimeoutMs);
      };

      resetWatchdog();

      const onAbort = async () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (child.pid) await killProcessGroupAndTree(child.pid);
        reject(new Error('Claude CLI invocation aborted'));
      };

      if (signal.aborted) {
        void onAbort();
        return;
      }
      signal.addEventListener('abort', () => void onAbort(), { once: true });

      child.stdout?.on('data', (chunk: Buffer) => {
        resetWatchdog();
        buffer += chunk.toString('utf8');
        let newlineIdx = buffer.indexOf('\n');
        while (newlineIdx !== -1) {
          const line = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);
          onLine(line);
          newlineIdx = buffer.indexOf('\n');
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
        if (buffer.trim().length > 0) {
          onLine(buffer);
        }
        if (child.pid) {
          await killProcessGroupAndTree(child.pid);
        }
        resolve({ exitCode: code ?? 1, stderr });
      });
    });
  }
}
