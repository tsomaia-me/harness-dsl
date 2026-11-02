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

export interface RateLimitResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
}

export interface RateLimitAdapter {
  fromResponse(response: RateLimitResponse, nowMs: number): QuotaPatch;
}

export interface QuotaPolicy {
  readonly thresholds: Readonly<Record<string, number>>;
  readonly defaultThreshold: number;
  readonly probeStalenessMs: number;
  readonly tokenBudget: number | null;
  readonly shareResetWindowId: string | null;
  readonly defaultCooldownMs: number;
  readonly unavailableCooldownMs: number;
}

export interface TokenCounts {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens?: number;
  readonly outputTokens: number;
}

export interface TokenUsage extends TokenCounts {
  readonly actualCostUsd: number | null;
  readonly equivalentCostUsd: number | null;
}

export interface PricingAdapter {
  estimate(modelId: string, usage: TokenCounts, atMs: number): number | null;
}

export interface DriverInvokeRequest {
  readonly accountId: string;
  readonly modelId: string;
  readonly modelOptions: Record<string, unknown>;
  readonly pricing?: PricingAdapter;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly outputJsonSchema: Record<string, unknown>;
  readonly workDir: string;
  readonly allowedTools?: readonly string[];
  readonly maxContextTokens?: number;
  readonly handoffBufferTokens?: number;
  readonly isIncomplete?: (structuredOutput: unknown) => boolean;
  readonly hookServerUrl?: string;
  readonly invocationId?: string;
  readonly hookSubscriptions?: HookSubscriptions;
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
    pricing?: PricingAdapter,
  ): Promise<{ batchId: string }>;
  poll(batchId: string): Promise<{
    status: 'running' | 'completed' | 'failed';
    results?: readonly BatchItemResult[];
  }>;
  cancel?(batchId: string): Promise<void>;
}

export interface Driver {
  readonly kind: string;
  invoke(req: DriverInvokeRequest): Promise<DriverInvokeResult>;
  probeQuota?(accountId: string): Promise<QuotaPatch>;
  readonly quotaPolicy?: Partial<QuotaPolicy>;
  readonly hookProtocol?: HookProtocol;
  readonly batch?: BatchAdapter;
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

export type ToolEventPhase = 'pre-tool' | 'post-tool' | 'stop';

export type ToolIntent = 'file-write';

export interface ToolEvent {
  readonly phase: ToolEventPhase;
  readonly intent: ToolIntent | null;
  readonly toolName?: string;
  readonly filePaths: readonly string[];
  readonly sessionId?: string;
  readonly transcriptPath?: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface HookDecision {
  readonly allow: boolean;
  readonly reason?: string;
  readonly additionalContext?: string;
}

export interface HookSubscriptions {
  readonly preToolIntents: readonly ToolIntent[];
  readonly stop: boolean;
}

export interface HookProtocol {
  readonly name: string;
  buildSettings(endpoint: string, subscriptions: HookSubscriptions): Record<string, unknown>;
  parse(payload: Record<string, unknown>): ToolEvent | null;
  formatDecision(event: ToolEvent, decision: HookDecision): Record<string, unknown>;
  readContextTokens(transcriptPath: string): number;
}
