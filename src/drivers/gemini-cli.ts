import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { hookEndpointUrl } from '../hooks.js';
import { googlePricing } from '../pricing/google.js';
import { parseRateLimitResetFromMessage } from '../rate-limits/claude-cli.js';
import type { HookSubscriptions } from '../types.js';
import { CliAgentDriver, type CliAgentAdapter, type CliSpawnBridge } from './cli-agent.js';

export type GeminiApprovalMode = 'plan' | 'auto_edit' | 'yolo';

export const GEMINI_CLI_RATE_LIMIT_TEXT = /\b429\b|\bresource_exhausted\b|\brate[ -]?limit|\bquota\b/i;
export const GEMINI_CLI_AUTH_FAILURE_TEXT = /api key not valid|\b401\b|\b403\b|permission_denied|unauthenticated|set an auth method/i;
export const GEMINI_WRITE_TOOLS = ['write_file', 'replace'];

export interface GeminiCliAdapterOptions {
  readonly apiKey?: string;
}

/** One guarded run at a time per directory: the settings file is the directory's, not the run's. */
const settingsTurns = new Map<string, Promise<void>>();

async function takeSettingsTurn(dir: string): Promise<() => void> {
  const previous = settingsTurns.get(dir) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const turn = previous.then(() => mine);
  settingsTurns.set(dir, turn);
  await previous;
  return () => {
    release();
    if (settingsTurns.get(dir) === turn) settingsTurns.delete(dir);
  };
}

/** The hook settings Gemini CLI reads from `.gemini/settings.json` in the directory it runs in. */
export function geminiHookSettings(endpoint: string, subscriptions: HookSubscriptions): Record<string, unknown> {
  const hook = { type: 'command', command: `curl -sS -X POST "${endpoint}" -H "content-type: application/json" --data-binary @-`, timeout: 30_000 };
  return {
    tools: { enableHooks: true },
    hooks: {
      enabled: true,
      ...(subscriptions.preToolIntents.includes('file-write') ? { BeforeTool: [{ matcher: GEMINI_WRITE_TOOLS.join('|'), hooks: [hook] }] } : {}),
      ...(subscriptions.stop ? { AfterAgent: [{ hooks: [hook] }] } : {}),
    },
  };
}

/**
 * The Gemini CLI as an agent adapter: `gemini -p` with stream-json, a session id, an approval mode from
 * the model options, the system prompt and the output schema folded into the prompt (the CLI has no
 * flags for either), and hook settings placed in the workspace's `.gemini/settings.json` for the run.
 */
export function geminiCliAdapter(options: GeminiCliAdapterOptions = {}): CliAgentAdapter {
  return {
    name: 'gemini-cli',
    binary: 'gemini',
    pricing: googlePricing,
    stripInheritedEnv: options.apiKey ? ['GEMINI_API_KEY'] : [],
    args(req, sessionId) {
      const mode = typeof req.modelOptions.approvalMode === 'string' ? (req.modelOptions.approvalMode as GeminiApprovalMode) : 'plan';
      const prompt = req.resumeSession
        ? req.userPrompt
        : [req.systemPrompt.trim(), req.userPrompt, `Answer only with JSON that matches this schema:\n${JSON.stringify(req.outputJsonSchema)}`].filter((part) => part.length > 0).join('\n\n');
      return ['-m', req.modelId, '--output-format', 'stream-json', '--approval-mode', mode, ...(req.resumeSession ? ['--resume', sessionId] : ['--session-id', sessionId]), '-p', prompt];
    },
    env() {
      return { GEMINI_CLI_TRUST_WORKSPACE: 'true', ...(options.apiKey ? { GEMINI_API_KEY: options.apiKey } : {}) };
    },
    event(event, state) {
      if (event.type === 'init' && typeof event.session_id === 'string') state.sessionId = event.session_id;
      if (event.type === 'message' && event.role === 'assistant' && typeof event.content === 'string') {
        state.rawText = event.delta === false ? event.content : state.rawText + event.content;
      }
      if (event.type === 'result') {
        const stats = event.stats ?? {};
        state.inputTokens = Math.max(state.inputTokens, Number(stats.input_tokens ?? 0));
        state.cachedInputTokens = Math.max(state.cachedInputTokens, Number(stats.cached ?? 0));
        state.outputTokens = Math.max(state.outputTokens, Number(stats.output_tokens ?? 0));
        if (event.status === 'error') {
          state.errorText = String(event.error?.message ?? event.error?.type ?? 'error');
          if (GEMINI_CLI_AUTH_FAILURE_TEXT.test(state.errorText)) state.authFailed = true;
          else if (GEMINI_CLI_RATE_LIMIT_TEXT.test(state.errorText)) {
            state.rateLimited = true;
            state.rejectedUntilMs = parseRateLimitResetFromMessage(state.errorText);
          }
        }
      }
      if (event.type === 'error' && typeof event.message === 'string' && !state.errorText) state.errorText = event.message;
    },
    ended(exitCode, stderr, state) {
      if (exitCode !== 0 && !state.rateLimited && !state.authFailed) {
        const text = state.errorText || stderr;
        if (GEMINI_CLI_AUTH_FAILURE_TEXT.test(text)) state.authFailed = true;
        else if (GEMINI_CLI_RATE_LIMIT_TEXT.test(text)) {
          state.rateLimited = true;
          state.rejectedUntilMs = parseRateLimitResetFromMessage(text);
        }
      }
    },
    async placeHookSettings(req, endpoint, subscriptions) {
      const dir = path.join(req.workDir, '.gemini');
      const file = path.join(dir, 'settings.json');
      const done = await takeSettingsTurn(path.resolve(req.workDir));
      const previous = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(geminiHookSettings(hookEndpointUrl(endpoint, req.invocationId!), subscriptions), null, 2), 'utf8');
      return {
        path: file,
        cleanup: () => {
          if (previous === undefined) rmSync(file, { force: true });
          else writeFileSync(file, previous, 'utf8');
          done();
        },
      };
    },
  };
}

export interface GeminiCliDriverOptions {
  readonly apiKey?: string;
  readonly geminiBinary?: string;
  readonly env?: Record<string, string>;
  readonly spawnBridge?: CliSpawnBridge;
}

export class GeminiCliDriver extends CliAgentDriver {
  public constructor(options: GeminiCliDriverOptions = {}) {
    super(geminiCliAdapter({ ...(options.apiKey ? { apiKey: options.apiKey } : {}) }), {
      ...(options.geminiBinary ? { binary: options.geminiBinary } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.spawnBridge ? { spawnBridge: options.spawnBridge } : {}),
    });
  }
}
