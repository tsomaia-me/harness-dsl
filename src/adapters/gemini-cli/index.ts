import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Intent } from '../../dsl/roles.js';
import type { CliAgentDriver } from '../../drivers/cli-agent.js';
import { GeminiCliDriver, GEMINI_WRITE_TOOLS, type GeminiApprovalMode } from '../../drivers/gemini-cli.js';
import type { GuardProtocol, Model, ModelRequest } from '../../kernel/backends.js';
import type { Account, QuotaPartition } from '../../kernel/quota.js';
import type { EnvRef, JsonObject, Resolver } from '../../kernel/refs.js';
import { CliModelDriver, type CliModelDriverOptions } from '../cli-model-driver.js';
import { DEFAULT_INACTIVITY_TIMEOUT_MS } from '../model-calls.js';

export { DEFAULT_INACTIVITY_TIMEOUT_MS };

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

export interface GeminiCliDriverOptions extends CliModelDriverOptions {
  readonly geminiBinary?: string;
}

/** The Gemini CLI behind the `ModelDriver` contract: one `gemini -p` per call, the role's intents as its approval mode. */
export class GeminiCliModelDriver extends CliModelDriver<'gemini-cli'> {
  private readonly geminiBinary: string | undefined;

  public constructor(options: GeminiCliDriverOptions = {}) {
    super('gemini-cli', geminiCliGuardProtocol, options, path.join(tmpdir(), 'harness-gemini-cli-sessions'));
    this.geminiBinary = options.geminiBinary;
  }

  protected createInner(account: Account, resolver: Resolver): CliAgentDriver {
    return new GeminiCliDriver({
      ...(account.credential ? { apiKey: resolver.env(account.credential) } : {}),
      ...(this.geminiBinary ? { geminiBinary: this.geminiBinary } : {}),
      ...(this.options.env ? { env: this.options.env } : {}),
      ...(this.options.spawnBridge ? { spawnBridge: this.options.spawnBridge } : {}),
    });
  }

  protected override modelOptions(request: ModelRequest): Record<string, unknown> {
    return { approvalMode: approvalModeFor(request.role.intents as readonly Intent[]) };
  }
}

export const geminiCli = {
  /** A Gemini API key the CLI signs in with, or the CLI's own sign-in when none is given, drawing on the named quota partition. */
  account(name: string, options: { readonly apiKey?: EnvRef; readonly quota: QuotaPartition }): Account<'gemini-cli'> {
    return { entity: 'account', name, driver: 'gemini-cli', ...(options.apiKey ? { credential: options.apiKey } : {}), quota: options.quota };
  },
  model(name: string, options: { readonly id: string }): Model<'gemini-cli'> {
    return { entity: 'model', name, id: options.id, driver: 'gemini-cli', batch: false };
  },
  driver(options?: GeminiCliDriverOptions): GeminiCliModelDriver {
    return new GeminiCliModelDriver(options);
  },
};
