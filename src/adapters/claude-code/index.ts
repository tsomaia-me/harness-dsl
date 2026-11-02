import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Intent } from '../../dsl/roles.js';
import { ClaudeCliDriver, type ClaudeCliSpawnBridge } from '../../drivers/claude-cli.js';
import type { CliAgentDriver } from '../../drivers/cli-agent.js';
import type { GuardProtocol, Model, ModelRequest } from '../../kernel/backends.js';
import type { Account, QuotaPartition } from '../../kernel/quota.js';
import type { EnvRef, JsonObject, Resolver } from '../../kernel/refs.js';
import { claudeCodeHookProtocol } from '../../protocols/claude-code.js';
import { CliModelDriver, type CliModelDriverOptions } from '../cli-model-driver.js';
import { DEFAULT_INACTIVITY_TIMEOUT_MS } from '../model-calls.js';
import { SessionDef, type SessionOptions, SupervisorClient, type SupervisorOptions } from './supervisor.js';

export { DEFAULT_INACTIVITY_TIMEOUT_MS, SessionDef, SupervisorClient, type SessionOptions, type SupervisorOptions };

/** The Claude Code hook payloads as the kernel's guard events: file writes and stops. */
export const claudeCodeGuardProtocol: GuardProtocol = {
  parse(payload: JsonObject) {
    const event = claudeCodeHookProtocol.parse(payload);
    if (!event || event.phase === 'post-tool') return null;
    return { phase: event.phase, filePaths: event.filePaths, raw: payload };
  },
  formatDecision(event, decision) {
    return claudeCodeHookProtocol.formatDecision({ phase: event.phase, intent: event.filePaths.length > 0 ? 'file-write' : null, filePaths: event.filePaths, raw: event.raw }, decision) as JsonObject;
  },
};

const TOOLS_BY_INTENT: Readonly<Record<Intent, readonly string[]>> = {
  read: ['Read', 'Glob', 'Grep'],
  edit: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
  run: ['Bash'],
  search: ['WebSearch'],
  browse: ['WebFetch'],
  halt: [],
  record: [],
};

export interface ClaudeCodeDriverOptions extends CliModelDriverOptions {
  readonly claudeBinary?: string;
  readonly spawnBridge?: ClaudeCliSpawnBridge;
}

/** The Claude CLI behind the `ModelDriver` contract: one `claude -p` per call, the role's intents as its allowed tools. */
export class ClaudeCodeDriver extends CliModelDriver<'claude-code'> {
  private readonly claudeBinary: string | undefined;

  public constructor(options: ClaudeCodeDriverOptions = {}) {
    super('claude-code', claudeCodeGuardProtocol, options, path.join(tmpdir(), 'harness-claude-code-sessions'));
    this.claudeBinary = options.claudeBinary;
  }

  protected createInner(credential: EnvRef | undefined, resolver: Resolver): CliAgentDriver {
    return new ClaudeCliDriver({
      ...(credential ? { oauthToken: resolver.env(credential) } : {}),
      ...(this.claudeBinary ? { claudeBinary: this.claudeBinary } : {}),
      ...(this.options.env ? { env: this.options.env } : {}),
      ...(this.options.spawnBridge ? { spawnBridge: this.options.spawnBridge } : {}),
    });
  }

  protected override allowedTools(request: ModelRequest): readonly string[] {
    return [...new Set(request.role.intents.flatMap((intent) => TOOLS_BY_INTENT[intent as Intent] ?? []))];
  }
}

export const claudeCode = {
  /** A Claude subscription, through an OAuth token or the CLI's own sign-in when none is given, drawing on the named quota partition. */
  subscription(name: string, options: { readonly token?: EnvRef; readonly quota: QuotaPartition }): Account<'claude-code'> {
    return { entity: 'account', name, driver: 'claude-code', ...(options.token ? { credential: options.token } : {}), quota: options.quota };
  },
  model(name: string, options: { readonly id: string }): Model<'claude-code'> {
    return { entity: 'model', name, id: options.id, driver: 'claude-code', batch: false };
  },
  driver(options?: ClaudeCodeDriverOptions): ClaudeCodeDriver {
    return new ClaudeCodeDriver(options);
  },
  /** A Claude Code session as a client: the granted operations as MCP tools. */
  supervisor(name: string, options: SupervisorOptions): SupervisorClient {
    return new SupervisorClient(name, options);
  },
  /** One session over several harnesses; writes the `.mcp.json` naming each supervisor. */
  session(name: string, options: SessionOptions): SessionDef {
    return new SessionDef(name, options);
  },
};
