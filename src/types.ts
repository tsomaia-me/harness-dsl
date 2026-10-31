import type { z } from 'zod';
import type { HarnessStore } from './store.js';

export type HeadCapability =
  | 'workflows:read'
  | 'workflows:control'
  | 'tickets:read'
  | 'tickets:write'
  | 'blockers:resolve'
  | 'lessons:manage'
  | 'accounts:manage'
  | 'telemetry:read'
  | 'runner:exec';

export interface QuotaWindow {
  readonly id: string;
  readonly utilization: number;
  readonly resetsAtMs: number | null;
}

export interface QuotaWindowPatch {
  readonly id: string;
  readonly utilization?: number;
  readonly resetsAtMs?: number | null;
}

export interface QuotaPatch {
  readonly windows?: readonly QuotaWindowPatch[];
  readonly cooldownUntilMs?: number | null;
}

export interface QuotaPolicy {
  readonly thresholds: Readonly<Record<string, number>>;
  readonly defaultThreshold: number;
  readonly probeStalenessMs: number;
  readonly tokenBudget: number | null;
  readonly shareResetWindowId: string | null;
  readonly defaultCooldownMs: number;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly actualCostUsd: number;
  readonly equivalentCostUsd: number;
}

export interface ExecutionContext {
  readonly runId: string;
  readonly iteration: number;
  readonly stepName: string;
  readonly projectDir: string;
  readonly workDir: string;
  readonly slotIndex: number;
  readonly slotPorts: readonly number[];
  readonly touchedPaths: readonly string[];
  readonly store: HarnessStore;
  readonly hookServerUrl?: string;
  readonly signal: AbortSignal;
}

export interface Executable<TInput = any, TOutput = any> {
  readonly kind: 'command' | 'agent-skill' | 'flow' | 'batch';
  readonly name: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly outputSchema: z.ZodType<TOutput>;
  execute(input: TInput, ctx: ExecutionContext): Promise<TOutput>;
}

export interface DriverInvokeRequest {
  readonly accountId: string;
  readonly modelId: string;
  readonly modelOptions: Record<string, unknown>;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly outputJsonSchema: Record<string, unknown>;
  readonly workDir: string;
  readonly allowedTools?: readonly string[];
  readonly customTools?: ReadonlyMap<string, Executable<any, any>>;
  readonly maxContextTokens?: number;
  readonly hookServerUrl?: string;
  readonly hookTypes?: readonly ('PreToolUse' | 'PostToolUse' | 'Stop')[];
  readonly runId: string;
  readonly stepName: string;
  readonly sessionId?: string;
  readonly resumeSession?: boolean;
  readonly inactivityTimeoutMs: number;
  readonly signal: AbortSignal;
}

export interface DriverInvokeResult {
  readonly structuredOutput: unknown;
  readonly rawText: string;
  readonly sessionId: string;
  readonly usage: TokenUsage;
  readonly handoffRequested?: {
    readonly summary: string;
    readonly remainingWork: readonly string[];
  };
  readonly quotaHint?: QuotaPatch;
}

export interface BatchItemRequest {
  readonly customId: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly outputJsonSchema: Record<string, unknown>;
}

export interface BatchItemResult {
  readonly customId: string;
  readonly ok: boolean;
  readonly structuredOutput?: unknown;
  readonly error?: string;
  readonly usage: TokenUsage;
}

export interface BatchAdapter {
  submit(
    items: readonly BatchItemRequest[],
    modelId: string,
    opts: Record<string, unknown>,
  ): Promise<{ batchId: string }>;
  poll(batchId: string): Promise<{
    status: 'running' | 'completed' | 'failed';
    results?: readonly BatchItemResult[];
  }>;
  cancel?(batchId: string): Promise<void>;
}

export interface Driver {
  readonly kind: 'claude-cli' | 'ai-sdk' | 'custom' | 'mock';
  invoke(req: DriverInvokeRequest): Promise<DriverInvokeResult>;
  probeQuota?(accountId: string): Promise<QuotaPatch>;
  readonly quotaPolicy?: Partial<QuotaPolicy>;
  readonly batch?: BatchAdapter;
}

export interface ResolvedAccount {
  readonly accountId: string;
  readonly driver: Driver;
  readonly maxQuotaShare: number;
  readonly quotaPolicy: QuotaPolicy;
}

export interface AccountProvider {
  readonly id: string;
  readonly maxQuotaShareValue: number;
  maxQuotaShare(ratio: number): this;
  acquireAccount(store: HarnessStore): Promise<ResolvedAccount>;
}

export interface CommandExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly all: string;
  readonly durationMs: number;
}

export interface CommandExecOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly timeoutMs?: number;
  readonly inactivityTimeoutMs?: number;
  readonly reject?: boolean;
  readonly signal?: AbortSignal;
}

export interface Runner {
  readonly id: string;
  readonly kind: 'local' | 'ssh';
  exec(
    command: string,
    opts?: CommandExecOptions,
  ): Promise<CommandExecResult & { slotIndex: number; slotPorts: readonly number[] }>;
  syncGitRef?(localWorkDir: string, sha: string, targetRef: string): Promise<void>;
}

export interface AgentPlugin {
  readonly name: string;
  readonly hookTypes?: readonly ('PreToolUse' | 'PostToolUse' | 'Stop')[];
  onPreToolUse?(
    payload: Record<string, unknown>,
    ctx: { runId: string; store: HarnessStore; workDir: string },
  ): Promise<{ allow: boolean; reason?: string }>;
  onStop?(
    payload: Record<string, unknown>,
    ctx: { runId: string; store: HarnessStore; workDir: string },
  ): Promise<{ allow: boolean; reason?: string }>;
}

export interface FlowMiddleware {
  readonly name: string;
  wrap<TInput, TOutput>(
    input: TInput,
    ctx: ExecutionContext,
    next: (updatedCtx: ExecutionContext) => Promise<TOutput>,
  ): Promise<TOutput>;
}

export interface LessonEntry {
  readonly id: string;
  readonly kind: 'domain' | 'behavioral';
  readonly roles: readonly string[];
  readonly paths: readonly string[];
  readonly rule: string;
  readonly createdAt: string;
}

export interface FlowContext<
  TInput = unknown,
  TSteps extends Record<string, any> = Record<string, unknown>,
> {
  readonly runId: string;
  readonly iteration: number;
  readonly input: TInput;
  readonly steps: TSteps;
  readonly prev?: TSteps;
  readonly resolutions: readonly unknown[];
  readonly workDir: string;
}
