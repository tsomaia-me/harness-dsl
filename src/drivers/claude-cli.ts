import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { hookEndpointUrl } from '../hooks.js';
import { anthropicPricing } from '../pricing/anthropic.js';
import { claudeCodeHookProtocol } from '../protocols/claude-code.js';
import { ANTHROPIC_5H_WINDOW, ANTHROPIC_7D_WINDOW } from '../rate-limits/anthropic.js';
import { CLAUDE_CLI_AUTH_FAILURE_TEXT, CLAUDE_CLI_RATE_LIMIT_TEXT, parseRateLimitResetFromMessage, readClaudeCliRateLimitEvent } from '../rate-limits/claude-cli.js';
import type { DriverInvokeRequest, QuotaPolicy } from '../types.js';
import { CliAgentDriver, type CliAgentAdapter, type CliAgentState, type CliSpawnBridge } from './cli-agent.js';

export const CLAUDE_SUBSCRIPTION_QUOTA_POLICY: Partial<QuotaPolicy> = {
  thresholds: { [ANTHROPIC_5H_WINDOW]: 0.95, [ANTHROPIC_7D_WINDOW]: 0.98 },
  tokenBudget: 5_000_000,
  shareResetWindowId: ANTHROPIC_7D_WINDOW,
};

export type ClaudeCliSpawnBridge = CliSpawnBridge;

export interface ClaudeCliDriverOptions {
  readonly configDir?: string;
  readonly oauthToken?: string;
  readonly claudeBinary?: string;
  readonly env?: Record<string, string>;
  readonly spawnBridge?: ClaudeCliSpawnBridge;
}

function expandHome(filepath: string): string {
  return filepath.startsWith('~/') ? path.join(homedir(), filepath.slice(2)) : filepath;
}

/** The Claude CLI as an agent adapter: `claude -p` with stream-json, a JSON schema, sessions and hook settings. */
export function claudeCliAdapter(options: { readonly configDir?: string; readonly oauthToken?: string } = {}): CliAgentAdapter {
  const configDir = options.configDir ? expandHome(options.configDir) : undefined;
  return {
    name: 'claude-cli',
    binary: 'claude',
    pricing: anthropicPricing,
    quotaPolicy: CLAUDE_SUBSCRIPTION_QUOTA_POLICY,
    prepaid: true,
    stripInheritedEnv: configDir || options.oauthToken ? ['ANTHROPIC_API_KEY'] : [],
    args(req, sessionId, settingsPath) {
      const args = ['-p', '--model', req.modelId, ...(req.resumeSession ? ['--resume', sessionId] : ['--session-id', sessionId]), '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(req.outputJsonSchema)];
      if (req.systemPrompt.trim().length > 0 && !req.resumeSession) args.push('--append-system-prompt', req.systemPrompt);
      if (req.allowedTools && req.allowedTools.length > 0) args.push('--allowedTools', req.allowedTools.join(','));
      if (settingsPath) args.push('--settings', settingsPath);
      args.push('--strict-mcp-config', req.userPrompt);
      return args;
    },
    env() {
      return {
        ...(configDir && configDir !== path.join(homedir(), '.claude') ? { CLAUDE_CONFIG_DIR: configDir } : {}),
        ...(options.oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: options.oauthToken } : {}),
      };
    },
    event(event, state) {
      const usage = event.message?.usage ?? event.usage;
      if (usage && typeof usage === 'object') {
        const input = Number(usage.input_tokens ?? 0);
        const cacheCreate = Number(usage.cache_creation_input_tokens ?? 0);
        const cacheRead = Number(usage.cache_read_input_tokens ?? 0);
        state.inputTokens = Math.max(state.inputTokens, input + cacheCreate + cacheRead);
        state.cachedInputTokens = Math.max(state.cachedInputTokens, cacheRead);
        state.cacheWriteTokens = Math.max(state.cacheWriteTokens, cacheCreate);
        state.outputTokens = Math.max(state.outputTokens, Number(usage.output_tokens ?? 0));
      }
      if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) if (block.type === 'text' && typeof block.text === 'string') state.rawText = block.text;
      }
      if (event.type === 'result') {
        if (typeof event.total_cost_usd === 'number') state.reportedCostUsd = event.total_cost_usd;
        if (event.structured_output !== undefined) state.structuredOutput = event.structured_output;
        else if (typeof event.result === 'string') {
          state.rawText = event.result;
          try {
            state.structuredOutput = JSON.parse(event.result);
          } catch (err) {
            void err;
          }
        }
      }
      const rateLimitEvent = readClaudeCliRateLimitEvent(event);
      if (rateLimitEvent) {
        state.quota = rateLimitEvent.quota;
        state.rejectedUntilMs = rateLimitEvent.rejectedUntilMs;
      }
      if (event.type === 'error' || event.is_error === true) {
        state.errorText = String(event.error?.message ?? event.result ?? '');
        const authStatus = event.api_error_status === 401 || event.api_error_status === 403;
        if (authStatus || CLAUDE_CLI_AUTH_FAILURE_TEXT.test(state.errorText)) state.authFailed = true;
        else if (event.api_error_status === 429 || CLAUDE_CLI_RATE_LIMIT_TEXT.test(state.errorText)) state.rateLimited = true;
      }
    },
    ended(exitCode, stderr, state: CliAgentState) {
      const failedWithoutOutput = exitCode !== 0 && state.structuredOutput === undefined;
      if (failedWithoutOutput && CLAUDE_CLI_AUTH_FAILURE_TEXT.test(stderr)) state.authFailed = true;
      if (failedWithoutOutput && CLAUDE_CLI_RATE_LIMIT_TEXT.test(stderr)) state.rateLimited = true;
      if (state.rateLimited && state.rejectedUntilMs === null) state.rejectedUntilMs = parseRateLimitResetFromMessage(state.errorText || stderr);
    },
    placeHookSettings(req: DriverInvokeRequest, endpoint, subscriptions) {
      const dir = path.join(tmpdir(), 'harness-cli-settings');
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `settings-${req.runId}-${req.stepName}-${randomUUID()}.json`);
      writeFileSync(file, JSON.stringify(claudeCodeHookProtocol.buildSettings(hookEndpointUrl(endpoint, req.invocationId!), subscriptions), null, 2), 'utf8');
      return { path: file, cleanup: () => rmSync(file, { force: true }) };
    },
  };
}

export class ClaudeCliDriver extends CliAgentDriver {
  public readonly configDir: string | undefined;

  public constructor(options: ClaudeCliDriverOptions = {}) {
    super(claudeCliAdapter({ ...(options.configDir ? { configDir: options.configDir } : {}), ...(options.oauthToken ? { oauthToken: options.oauthToken } : {}) }), {
      ...(options.claudeBinary ? { binary: options.claudeBinary } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.spawnBridge ? { spawnBridge: options.spawnBridge } : {}),
    });
    this.configDir = options.configDir ? expandHome(options.configDir) : undefined;
  }
}
