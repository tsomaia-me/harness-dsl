import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';
import { drivers } from './drivers/index.js';
import { AccountDef, PoolDef, RateLimitedError } from './quota.js';
import { LocalRunner, type LocalRunnerOptions, SshRunner, type SshRunnerOptions } from './runner.js';
import type {
  AccountProvider,
  AgentPlugin,
  CommandExecOptions,
  CommandExecResult,
  Driver,
  Executable,
  ExecutionContext,
  FlowContext,
  FlowMiddleware,
  HeadCapability,
  Runner,
} from './types.js';

export function parseEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, 'utf8');
  const parsed = parseEnv(raw);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'string') {
      out[k] = v;
    }
  }
  return out;
}

export class ModelDef {
  public readonly accountProvider: AccountProvider;
  public readonly modelId: string;
  public readonly options: Record<string, unknown>;

  public constructor(
    accountProvider: AccountProvider,
    modelId: string,
    options: Record<string, unknown> = {},
  ) {
    this.accountProvider = accountProvider;
    this.modelId = modelId;
    this.options = options;
  }
}

export type CommandHandler<TInput, TOutput> = (args: {
  readonly input: TInput;
  readonly ctx: ExecutionContext;
  readonly exec: (
    cmd: string,
    opts?: CommandExecOptions,
  ) => Promise<CommandExecResult & { slotIndex: number; slotPorts: readonly number[] }>;
}) => Promise<TOutput> | TOutput;

export class CommandDef<TInput = unknown, TOutput = unknown>
  implements Executable<TInput, TOutput>
{
  public readonly kind = 'command' as const;
  public readonly name: string;
  public readonly inputSchema: z.ZodType<TInput>;
  public readonly outputSchema: z.ZodType<TOutput>;
  public readonly runnerInstance: Runner;
  public readonly envFilePath?: string;
  private readonly handlerFn?: CommandHandler<TInput, TOutput>;

  public constructor(
    name: string,
    opts?: {
      inputSchema?: z.ZodType<TInput>;
      outputSchema?: z.ZodType<TOutput>;
      runnerInstance?: Runner;
      envFilePath?: string;
      handlerFn?: CommandHandler<TInput, TOutput>;
    },
  ) {
    this.name = name;
    this.inputSchema = (opts?.inputSchema ?? z.any()) as z.ZodType<TInput>;
    this.outputSchema = (opts?.outputSchema ?? z.any()) as z.ZodType<TOutput>;
    this.runnerInstance = opts?.runnerInstance ?? new LocalRunner();
    this.envFilePath = opts?.envFilePath;
    this.handlerFn = opts?.handlerFn;
  }

  public input<TNewIn>(schema: z.ZodType<TNewIn>): CommandDef<TNewIn, TOutput> {
    return new CommandDef<TNewIn, TOutput>(this.name, {
      inputSchema: schema,
      outputSchema: this.outputSchema,
      runnerInstance: this.runnerInstance,
      envFilePath: this.envFilePath,
      handlerFn: this.handlerFn as unknown as CommandHandler<TNewIn, TOutput> | undefined,
    });
  }

  public output<TNewOut>(schema: z.ZodType<TNewOut>): CommandDef<TInput, TNewOut> {
    return new CommandDef<TInput, TNewOut>(this.name, {
      inputSchema: this.inputSchema,
      outputSchema: schema,
      runnerInstance: this.runnerInstance,
      envFilePath: this.envFilePath,
      handlerFn: this.handlerFn as unknown as CommandHandler<TInput, TNewOut> | undefined,
    });
  }

  public runner(runnerInstance: Runner): CommandDef<TInput, TOutput> {
    return new CommandDef<TInput, TOutput>(this.name, {
      inputSchema: this.inputSchema,
      outputSchema: this.outputSchema,
      runnerInstance,
      envFilePath: this.envFilePath,
      handlerFn: this.handlerFn,
    });
  }

  public envFrom(filePath: string): CommandDef<TInput, TOutput> {
    return new CommandDef<TInput, TOutput>(this.name, {
      inputSchema: this.inputSchema,
      outputSchema: this.outputSchema,
      runnerInstance: this.runnerInstance,
      envFilePath: filePath,
      handlerFn: this.handlerFn,
    });
  }

  public run(handlerFn: CommandHandler<TInput, TOutput>): CommandDef<TInput, TOutput> {
    return new CommandDef<TInput, TOutput>(this.name, {
      inputSchema: this.inputSchema,
      outputSchema: this.outputSchema,
      runnerInstance: this.runnerInstance,
      envFilePath: this.envFilePath,
      handlerFn,
    });
  }

  public async execute(rawInput: TInput, ctx: ExecutionContext): Promise<TOutput> {
    if (!this.handlerFn) {
      throw new Error(`Command "${this.name}" has no .run() handler defined`);
    }
    const parsedInput = this.inputSchema.parse(rawInput);
    const invId = `inv-${randomUUID()}`;
    ctx.store.startInvocation({
      id: invId,
      runId: ctx.runId,
      iteration: ctx.iteration,
      stepName: ctx.stepName,
      actorName: this.name,
      actorKind: 'command',
      runnerId: this.runnerInstance.id,
    });

    const resolvedEnvFile = this.envFilePath
      ? path.isAbsolute(this.envFilePath)
        ? this.envFilePath
        : path.join(ctx.projectDir, this.envFilePath)
      : undefined;
    const fileEnv = resolvedEnvFile ? parseEnvFile(resolvedEnvFile) : {};

    try {
      const execFn = (cmd: string, opts?: CommandExecOptions) =>
        this.runnerInstance.exec(cmd, {
          cwd: opts?.cwd ?? ctx.workDir,
          env: { ...fileEnv, ...(opts?.env ?? {}) },
          timeoutMs: opts?.timeoutMs,
          inactivityTimeoutMs: opts?.inactivityTimeoutMs,
          reject: opts?.reject,
          signal: opts?.signal ?? ctx.signal,
        });

      const rawOutput = await this.handlerFn({
        input: parsedInput,
        ctx,
        exec: execFn,
      });
      const validated = this.outputSchema.parse(rawOutput);
      ctx.store.finishInvocation(invId, {
        status: 'pass',
        output: validated,
      });
      return validated;
    } catch (err) {
      ctx.store.finishInvocation(invId, {
        status: 'fail',
        errorText: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}

export class SkillDef<TInput = unknown, TOutput = unknown> {
  public readonly name: string;
  public readonly inputSchema: z.ZodType<TInput>;
  public readonly outputSchema: z.ZodType<TOutput>;
  public readonly promptBuilder?: (input: TInput) => string;
  public readonly assertFn?: (output: TOutput, input: TInput) => Promise<void> | void;
  public readonly maxRetriesCount: number;

  public constructor(
    name: string,
    opts?: {
      inputSchema?: z.ZodType<TInput>;
      outputSchema?: z.ZodType<TOutput>;
      promptBuilder?: (input: TInput) => string;
      assertFn?: (output: TOutput, input: TInput) => Promise<void> | void;
      maxRetriesCount?: number;
    },
  ) {
    this.name = name;
    this.inputSchema = (opts?.inputSchema ?? z.any()) as z.ZodType<TInput>;
    this.outputSchema = (opts?.outputSchema ?? z.any()) as z.ZodType<TOutput>;
    this.promptBuilder = opts?.promptBuilder;
    this.assertFn = opts?.assertFn;
    this.maxRetriesCount = opts?.maxRetriesCount ?? 2;
  }

  public input<TNewIn>(schema: z.ZodType<TNewIn>): SkillDef<TNewIn, TOutput> {
    return new SkillDef<TNewIn, TOutput>(this.name, {
      inputSchema: schema,
      outputSchema: this.outputSchema,
      assertFn: undefined,
      maxRetriesCount: this.maxRetriesCount,
    });
  }

  public output<TNewOut>(schema: z.ZodType<TNewOut>): SkillDef<TInput, TNewOut> {
    return new SkillDef<TInput, TNewOut>(this.name, {
      inputSchema: this.inputSchema,
      outputSchema: schema,
      promptBuilder: this.promptBuilder,
      assertFn: undefined,
      maxRetriesCount: this.maxRetriesCount,
    });
  }

  public prompt(templateOrBuilder: string | ((input: TInput) => string)): SkillDef<TInput, TOutput> {
    const fn =
      typeof templateOrBuilder === 'string'
        ? (input: TInput) => `${templateOrBuilder}\n\nInput:\n${JSON.stringify(input, null, 2)}`
        : templateOrBuilder;
    return new SkillDef<TInput, TOutput>(this.name, {
      inputSchema: this.inputSchema,
      outputSchema: this.outputSchema,
      promptBuilder: fn,
      assertFn: this.assertFn,
      maxRetriesCount: this.maxRetriesCount,
    });
  }

  public assert(
    assertFn: (output: TOutput, input: TInput) => Promise<void> | void,
  ): SkillDef<TInput, TOutput> {
    return new SkillDef<TInput, TOutput>(this.name, {
      inputSchema: this.inputSchema,
      outputSchema: this.outputSchema,
      promptBuilder: this.promptBuilder,
      assertFn,
      maxRetriesCount: this.maxRetriesCount,
    });
  }

  public maxRetries(count: number): SkillDef<TInput, TOutput> {
    return new SkillDef<TInput, TOutput>(this.name, {
      inputSchema: this.inputSchema,
      outputSchema: this.outputSchema,
      promptBuilder: this.promptBuilder,
      assertFn: this.assertFn,
      maxRetriesCount: count,
    });
  }
}

export class BoundAgentSkill<TInput = unknown, TOutput = unknown, TFlowCtx = any>
  implements Executable<TInput, TOutput>
{
  public readonly kind = 'agent-skill' as const;
  public readonly name: string;
  public readonly agent: AgentDef;
  public readonly skill: SkillDef<TInput, TOutput>;
  public readonly inputSchema: z.ZodType<TInput>;
  public readonly outputSchema: z.ZodType<TOutput>;
  public readonly inputMapper?: (ctx: TFlowCtx) => TInput;

  public constructor(
    agent: AgentDef,
    skill: SkillDef<TInput, TOutput>,
    inputMapper?: (ctx: TFlowCtx) => TInput,
  ) {
    this.agent = agent;
    this.skill = skill;
    this.name = `${agent.name}:${skill.name}`;
    this.inputSchema = skill.inputSchema;
    this.outputSchema = skill.outputSchema;
    this.inputMapper = inputMapper;
  }

  public buildSystemPrompt(
    projectDir: string,
    store: ExecutionContext['store'],
    touchedPaths: readonly string[],
  ): string {
    const parts: string[] = [];
    if (this.agent.promptText) {
      parts.push(this.agent.promptText);
    }
    if (this.agent.promptFilePath) {
      const fullPath = path.isAbsolute(this.agent.promptFilePath)
        ? this.agent.promptFilePath
        : path.join(projectDir, this.agent.promptFilePath);
      if (existsSync(fullPath)) {
        parts.push(readFileSync(fullPath, 'utf8').trim());
      }
    }
    const lessons = store.filterLessons(this.agent.name, touchedPaths);
    if (lessons.length > 0) {
      const formatted = lessons.map((l) => `- [${l.id}] ${l.rule}`).join('\n');
      parts.push(`## Active Scoped Lessons\n${formatted}`);
    }
    return parts.join('\n\n');
  }

  public buildUserPrompt(parsedInput: TInput): string {
    if (this.skill.promptBuilder) {
      return this.skill.promptBuilder(parsedInput);
    }
    return typeof parsedInput === 'string'
      ? parsedInput
      : `Execute skill "${this.skill.name}" with input:\n${JSON.stringify(parsedInput, null, 2)}`;
  }

  public getOutputJsonSchema(): Record<string, unknown> {
    try {
      const raw = z.toJSONSchema(this.skill.outputSchema, { target: 'draft-7' }) as Record<
        string,
        unknown
      >;
      const { $schema: _ignored, ...rest } = raw;
      return rest;
    } catch {
      return { type: 'object' };
    }
  }

  public async execute(rawInput: TInput, ctx: ExecutionContext): Promise<TOutput> {
    if (!this.agent.modelDef) {
      throw new Error(`Agent "${this.agent.name}" has no .model() configured`);
    }

    const parsedInput = this.skill.inputSchema.parse(rawInput);
    const systemPrompt = this.buildSystemPrompt(ctx.projectDir, ctx.store, ctx.touchedPaths);
    const baseUserPrompt = this.buildUserPrompt(parsedInput);
    const outputJsonSchema = this.getOutputJsonSchema();

    const hookTypes = Array.from(
      new Set(this.agent.plugins.flatMap((p) => p.hookTypes ?? [])),
    ) as ('PreToolUse' | 'PostToolUse' | 'Stop')[];

    let attempt = 0;
    let validationFeedback = '';
    let handoffContext = '';
    let currentSessionId: string | undefined;
    let isRetrySession = false;

    while (attempt <= this.skill.maxRetriesCount) {
      const resolvedAccount = await this.agent.modelDef.accountProvider.acquireAccount(ctx.store);
      const invId = `inv-${randomUUID()}`;
      ctx.store.startInvocation({
        id: invId,
        runId: ctx.runId,
        iteration: ctx.iteration,
        stepName: ctx.stepName,
        actorName: this.agent.name,
        actorKind: 'agent',
        accountId: resolvedAccount.accountId,
        modelId: this.agent.modelDef.modelId,
        sessionId: currentSessionId,
      });

      const effectiveUserPrompt = [baseUserPrompt, handoffContext, validationFeedback]
        .filter((s) => s.length > 0)
        .join('\n\n');

      try {
        const result = await resolvedAccount.driver.invoke({
          accountId: resolvedAccount.accountId,
          modelId: this.agent.modelDef.modelId,
          modelOptions: this.agent.modelDef.options,
          systemPrompt,
          userPrompt: effectiveUserPrompt,
          outputJsonSchema,
          workDir: ctx.workDir,
          allowedTools: this.agent.allowedTools,
          customTools: this.agent.customTools,
          maxContextTokens: this.agent.maxContextTokensLimit,
          hookServerUrl: ctx.hookServerUrl,
          hookTypes,
          runId: ctx.runId,
          stepName: ctx.stepName,
          sessionId: currentSessionId,
          resumeSession: isRetrySession,
          inactivityTimeoutMs: this.agent.inactivityTimeoutMsValue,
          signal: ctx.signal,
        });

        if (result.quotaHint) {
          ctx.store.upsertAccountQuota(resolvedAccount.accountId, result.quotaHint);
        }

        if (result.handoffRequested) {
          ctx.store.finishInvocation(invId, {
            status: 'pass',
            sessionId: result.sessionId,
            ...result.usage,
            output: { handoff: result.handoffRequested },
          });
          currentSessionId = randomUUID();
          isRetrySession = false;
          handoffContext = [
            '## Handoff from Prior Session (Context Ceiling Reached)',
            `Summary: ${result.handoffRequested.summary}`,
            `Remaining Work: ${result.handoffRequested.remainingWork.join('; ')}`,
          ].join('\n');
          continue;
        }

        const parsedOut = this.skill.outputSchema.safeParse(result.structuredOutput);
        if (!parsedOut.success) {
          const errMsg = parsedOut.error.issues
            .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
            .join('; ');
          throw new SchemaValidationError(`Output failed Zod validation: ${errMsg}`, result);
        }

        if (this.skill.assertFn) {
          try {
            await this.skill.assertFn(parsedOut.data, parsedInput);
          } catch (assertErr) {
            throw new SchemaValidationError(
              `Output failed semantic assertion: ${
                assertErr instanceof Error ? assertErr.message : String(assertErr)
              }`,
              result,
            );
          }
        }

        ctx.store.finishInvocation(invId, {
          status: 'pass',
          sessionId: result.sessionId,
          ...result.usage,
          output: parsedOut.data,
        });

        return parsedOut.data;
      } catch (err: any) {
        if (err instanceof RateLimitedError) {
          ctx.store.upsertAccountQuota(resolvedAccount.accountId, {
            ...err.quota,
            cooldownUntilMs:
              err.quota.cooldownUntilMs ?? Date.now() + resolvedAccount.quotaPolicy.defaultCooldownMs,
          });
          ctx.store.finishInvocation(invId, {
            status: 'fail',
            errorText: err.message,
          });
          isRetrySession = false;
          continue;
        }

        if (err instanceof SchemaValidationError) {
          ctx.store.finishInvocation(invId, {
            status: 'fail',
            sessionId: err.driverResult.sessionId,
            ...err.driverResult.usage,
            errorText: err.message,
          });
          attempt += 1;
          if (attempt > this.skill.maxRetriesCount) {
            throw new Error(
              `Skill "${this.skill.name}" failed validation after ${this.skill.maxRetriesCount + 1} attempts: ${err.message}`,
            );
          }
          currentSessionId = err.driverResult.sessionId;
          isRetrySession = true;
          validationFeedback = `Your previous output was invalid (${err.message}). Return corrected JSON matching the schema.`;
          continue;
        }

        ctx.store.finishInvocation(invId, {
          status: 'fail',
          errorText: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }

    throw new Error(`Skill "${this.skill.name}" exhausted retries`);
  }
}

class SchemaValidationError extends Error {
  public readonly driverResult: {
    readonly sessionId: string;
    readonly usage: {
      readonly inputTokens: number;
      readonly cachedInputTokens: number;
      readonly outputTokens: number;
      readonly actualCostUsd: number;
      readonly equivalentCostUsd: number;
    };
  };

  public constructor(message: string, driverResult: any) {
    super(message);
    this.name = 'SchemaValidationError';
    this.driverResult = driverResult;
  }
}

export class AgentDef {
  public readonly name: string;
  public readonly modelDef?: ModelDef;
  public readonly maxContextTokensLimit?: number;
  public readonly inactivityTimeoutMsValue: number;
  public readonly promptText?: string;
  public readonly promptFilePath?: string;
  public readonly allowedTools: readonly string[];
  public readonly customTools: ReadonlyMap<string, Executable<any, any>>;
  public readonly plugins: readonly AgentPlugin[];

  public constructor(
    name: string,
    opts?: {
      modelDef?: ModelDef;
      maxContextTokensLimit?: number;
      inactivityTimeoutMsValue?: number;
      promptText?: string;
      promptFilePath?: string;
      allowedTools?: readonly string[];
      customTools?: ReadonlyMap<string, Executable<any, any>>;
      plugins?: readonly AgentPlugin[];
    },
  ) {
    this.name = name;
    this.modelDef = opts?.modelDef;
    this.maxContextTokensLimit = opts?.maxContextTokensLimit;
    this.inactivityTimeoutMsValue = opts?.inactivityTimeoutMsValue ?? 120_000;
    this.promptText = opts?.promptText;
    this.promptFilePath = opts?.promptFilePath;
    this.allowedTools = opts?.allowedTools ?? [];
    this.customTools = opts?.customTools ?? new Map();
    this.plugins = opts?.plugins ?? [];
  }

  public model(modelDef: ModelDef): AgentDef {
    return new AgentDef(this.name, {
      modelDef,
      maxContextTokensLimit: this.maxContextTokensLimit,
      inactivityTimeoutMsValue: this.inactivityTimeoutMsValue,
      promptText: this.promptText,
      promptFilePath: this.promptFilePath,
      allowedTools: this.allowedTools,
      customTools: this.customTools,
      plugins: this.plugins,
    });
  }

  public maxContextTokens(limit: number): AgentDef {
    return new AgentDef(this.name, {
      modelDef: this.modelDef,
      maxContextTokensLimit: limit,
      inactivityTimeoutMsValue: this.inactivityTimeoutMsValue,
      promptText: this.promptText,
      promptFilePath: this.promptFilePath,
      allowedTools: this.allowedTools,
      customTools: this.customTools,
      plugins: this.plugins,
    });
  }

  public inactivityTimeoutMs(ms: number): AgentDef {
    return new AgentDef(this.name, {
      modelDef: this.modelDef,
      maxContextTokensLimit: this.maxContextTokensLimit,
      inactivityTimeoutMsValue: ms,
      promptText: this.promptText,
      promptFilePath: this.promptFilePath,
      allowedTools: this.allowedTools,
      customTools: this.customTools,
      plugins: this.plugins,
    });
  }

  public prompt(text: string): AgentDef {
    return new AgentDef(this.name, {
      modelDef: this.modelDef,
      maxContextTokensLimit: this.maxContextTokensLimit,
      inactivityTimeoutMsValue: this.inactivityTimeoutMsValue,
      promptText: text,
      promptFilePath: this.promptFilePath,
      allowedTools: this.allowedTools,
      customTools: this.customTools,
      plugins: this.plugins,
    });
  }

  public promptFile(filePath: string): AgentDef {
    return new AgentDef(this.name, {
      modelDef: this.modelDef,
      maxContextTokensLimit: this.maxContextTokensLimit,
      inactivityTimeoutMsValue: this.inactivityTimeoutMsValue,
      promptText: this.promptText,
      promptFilePath: filePath,
      allowedTools: this.allowedTools,
      customTools: this.customTools,
      plugins: this.plugins,
    });
  }

  public tools(toolNames: readonly string[]): AgentDef {
    return new AgentDef(this.name, {
      modelDef: this.modelDef,
      maxContextTokensLimit: this.maxContextTokensLimit,
      inactivityTimeoutMsValue: this.inactivityTimeoutMsValue,
      promptText: this.promptText,
      promptFilePath: this.promptFilePath,
      allowedTools: [...toolNames],
      customTools: this.customTools,
      plugins: this.plugins,
    });
  }

  public tool(name: string, executable: Executable<any, any>): AgentDef {
    const nextMap = new Map(this.customTools);
    nextMap.set(name, executable);
    return new AgentDef(this.name, {
      modelDef: this.modelDef,
      maxContextTokensLimit: this.maxContextTokensLimit,
      inactivityTimeoutMsValue: this.inactivityTimeoutMsValue,
      promptText: this.promptText,
      promptFilePath: this.promptFilePath,
      allowedTools: this.allowedTools,
      customTools: nextMap,
      plugins: this.plugins,
    });
  }

  public use(plugin: AgentPlugin): AgentDef {
    return new AgentDef(this.name, {
      modelDef: this.modelDef,
      maxContextTokensLimit: this.maxContextTokensLimit,
      inactivityTimeoutMsValue: this.inactivityTimeoutMsValue,
      promptText: this.promptText,
      promptFilePath: this.promptFilePath,
      allowedTools: this.allowedTools,
      customTools: this.customTools,
      plugins: [...this.plugins, plugin],
    });
  }

  public run<TInput, TOutput, TFlowCtx = any>(
    skill: SkillDef<TInput, TOutput>,
    inputMapper?: (ctx: TFlowCtx) => TInput,
  ): BoundAgentSkill<TInput, TOutput, TFlowCtx> {
    return new BoundAgentSkill(this, skill, inputMapper);
  }
}

export class ConditionalExecutable<TInput = any, TOutput = any, TFlowCtx = any> {
  public readonly predicate: (ctx: TFlowCtx) => boolean;
  public readonly executable: Executable<TInput, TOutput>;
  public readonly mapInput?: (ctx: TFlowCtx) => TInput;

  public constructor(
    predicate: (ctx: TFlowCtx) => boolean,
    executable: Executable<TInput, TOutput>,
    mapInput?: (ctx: TFlowCtx) => TInput,
  ) {
    this.predicate = predicate;
    this.executable = executable;
    this.mapInput = mapInput;
  }
}

export type FlowNode =
  | {
      readonly type: 'step';
      readonly name: string;
      readonly executable: Executable<any, any>;
      readonly mapInput?: (ctx: FlowContext<any, any>) => any;
    }
  | {
      readonly type: 'when';
      readonly predicate: (ctx: FlowContext<any, any>) => boolean;
      readonly subflow?: FlowDef<any, any>;
      readonly executable?: Executable<any, any>;
      readonly stepName?: string;
      readonly mapInput?: (ctx: FlowContext<any, any>) => any;
    }
  | {
      readonly type: 'branch';
      readonly selector: (ctx: FlowContext<any, any>) => string;
      readonly branches: Record<string, FlowDef<any, any> | Executable<any, any>>;
    }
  | {
      readonly type: 'parallel';
      readonly branches: Record<
        string,
        | Executable<any, any>
        | ConditionalExecutable<any, any, any>
        | { executable: Executable<any, any>; mapInput?: (ctx: FlowContext<any, any>) => any }
      >;
    }
  | {
      readonly type: 'loop';
      readonly maxIterations: number;
      readonly bodyFlow: FlowDef<any, any>;
      readonly until: (ctx: FlowContext<any, any>) => boolean;
    }
  | {
      readonly type: 'batch';
      readonly name: string;
      readonly items: (ctx: FlowContext<any, any>) => readonly any[] | Promise<readonly any[]>;
      readonly execute: Executable<any, any>;
      readonly concurrency: number;
    }
  | {
      readonly type: 'haltIf';
      readonly predicate: (ctx: FlowContext<any, any>) => boolean;
      readonly mapBlocker?: (ctx: FlowContext<any, any>) => { reason: string } | string;
    };

type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (
  k: infer I,
) => void
  ? I
  : never;

export type BranchStepsResult<
  TInput,
  TSteps extends Record<string, any>,
  TBranches extends Record<
    string,
    Executable<any, any> | ((sub: FlowDef<TInput, TSteps>) => FlowDef<TInput, any>)
  >,
> = Partial<
  UnionToIntersection<
    {
      [K in keyof TBranches]: TBranches[K] extends (
        sub: FlowDef<TInput, TSteps>,
      ) => FlowDef<TInput, infer TSubOut>
        ? Omit<TSubOut, keyof TSteps>
        : TBranches[K] extends Executable<any, infer TExecOut>
          ? Record<K & string, TExecOut>
          : Record<string, never>;
    }[keyof TBranches]
  >
>;

export class FlowDef<
  TInput = unknown,
  TSteps extends Record<string, any> = {},
> implements Executable<TInput, TSteps>
{
  public readonly kind = 'flow' as const;
  public readonly name: string;
  public readonly inputSchema: z.ZodType<TInput>;
  public readonly outputSchema: z.ZodType<TSteps>;
  public readonly nodes: readonly FlowNode[];
  public readonly middlewares: readonly FlowMiddleware[];
  public readonly errorHandler?: (
    error: unknown,
    ctx: FlowContext<TInput, TSteps>,
  ) => Promise<void> | void;
  public readonly finallyHandler?:
    | Executable<any, any>
    | ((ctx: FlowContext<TInput, TSteps>) => Promise<void> | void);

  public constructor(
    name: string,
    opts?: {
      inputSchema?: z.ZodType<TInput>;
      nodes?: readonly FlowNode[];
      middlewares?: readonly FlowMiddleware[];
      errorHandler?: (error: unknown, ctx: FlowContext<TInput, TSteps>) => Promise<void> | void;
      finallyHandler?:
        | Executable<any, any>
        | ((ctx: FlowContext<TInput, TSteps>) => Promise<void> | void);
    },
  ) {
    this.name = name;
    this.inputSchema = (opts?.inputSchema ?? z.any()) as z.ZodType<TInput>;
    this.outputSchema = z.any() as z.ZodType<TSteps>;
    this.nodes = opts?.nodes ?? [];
    this.middlewares = opts?.middlewares ?? [];
    this.errorHandler = opts?.errorHandler;
    this.finallyHandler = opts?.finallyHandler;
  }

  public input<TNewInput>(schema: z.ZodType<TNewInput>): FlowDef<TNewInput, TSteps> {
    return new FlowDef<TNewInput, TSteps>(this.name, {
      inputSchema: schema,
      nodes: this.nodes,
      middlewares: this.middlewares,
      errorHandler: this.errorHandler as any,
      finallyHandler: this.finallyHandler as any,
    });
  }

  public use(middleware: FlowMiddleware): FlowDef<TInput, TSteps> {
    return new FlowDef<TInput, TSteps>(this.name, {
      inputSchema: this.inputSchema,
      nodes: this.nodes,
      middlewares: [...this.middlewares, middleware],
      errorHandler: this.errorHandler,
      finallyHandler: this.finallyHandler,
    });
  }

  public step<K extends string, TStepIn, TStepOut>(
    name: K,
    executable: Executable<TStepIn, TStepOut>,
    mapInput?: (ctx: FlowContext<TInput, TSteps>) => TStepIn,
  ): FlowDef<TInput, TSteps & Record<K, TStepOut>> {
    const mapper =
      mapInput ??
      (executable instanceof BoundAgentSkill && executable.inputMapper
        ? executable.inputMapper
        : undefined);
    const node: FlowNode = {
      type: 'step',
      name,
      executable,
      mapInput: mapper,
    };
    return new FlowDef<TInput, TSteps & Record<K, TStepOut>>(this.name, {
      inputSchema: this.inputSchema,
      nodes: [...this.nodes, node],
      middlewares: this.middlewares,
      errorHandler: this.errorHandler as any,
      finallyHandler: this.finallyHandler as any,
    });
  }

  public when<TSubOut extends Record<string, any>>(
    predicate: (ctx: FlowContext<TInput, TSteps>) => boolean,
    target: (sub: FlowDef<TInput, TSteps>) => FlowDef<TInput, TSubOut>,
  ): FlowDef<TInput, TSteps & Partial<Omit<TSubOut, keyof TSteps>>>;
  public when<TExecIn, TExecOut>(
    predicate: (ctx: FlowContext<TInput, TSteps>) => boolean,
    target: Executable<TExecIn, TExecOut>,
    mapInput?: (ctx: FlowContext<TInput, TSteps>) => TExecIn,
  ): FlowDef<TInput, TSteps>;
  public when(
    predicate: (ctx: FlowContext<TInput, TSteps>) => boolean,
    target:
      | Executable<any, any>
      | ((sub: FlowDef<TInput, TSteps>) => FlowDef<TInput, any>),
    mapInput?: (ctx: FlowContext<TInput, TSteps>) => any,
  ): FlowDef<TInput, any> {
    if (typeof target === 'function') {
      const subflow = target(
        new FlowDef<TInput, TSteps>(`${this.name}:when`, { inputSchema: this.inputSchema }),
      );
      const node: FlowNode = {
        type: 'when',
        predicate,
        subflow,
      };
      return new FlowDef(this.name, {
        inputSchema: this.inputSchema,
        nodes: [...this.nodes, node],
        middlewares: this.middlewares,
        errorHandler: this.errorHandler as any,
        finallyHandler: this.finallyHandler as any,
      });
    }

    const mapper =
      mapInput ??
      (target instanceof BoundAgentSkill && target.inputMapper ? target.inputMapper : undefined);
    const node: FlowNode = {
      type: 'when',
      predicate,
      executable: target,
      stepName: target.name,
      mapInput: mapper,
    };
    return new FlowDef(this.name, {
      inputSchema: this.inputSchema,
      nodes: [...this.nodes, node],
      middlewares: this.middlewares,
      errorHandler: this.errorHandler as any,
      finallyHandler: this.finallyHandler as any,
    });
  }

  public branch<
    TBranches extends Record<
      string,
      Executable<any, any> | ((sub: FlowDef<TInput, TSteps>) => FlowDef<TInput, any>)
    >,
  >(
    selector: (ctx: FlowContext<TInput, TSteps>) => keyof TBranches & string,
    branches: TBranches,
  ): FlowDef<TInput, TSteps & BranchStepsResult<TInput, TSteps, TBranches>> {
    const compiled: Record<string, FlowDef<any, any> | Executable<any, any>> = {};
    for (const [key, val] of Object.entries(branches)) {
      if (typeof val === 'function') {
        compiled[key] = val(
          new FlowDef<TInput, TSteps>(`${this.name}:branch:${key}`, {
            inputSchema: this.inputSchema,
          }),
        );
      } else {
        compiled[key] = val;
      }
    }
    const node: FlowNode = {
      type: 'branch',
      selector: selector as (ctx: FlowContext<any, any>) => string,
      branches: compiled,
    };
    return new FlowDef(this.name, {
      inputSchema: this.inputSchema,
      nodes: [...this.nodes, node],
      middlewares: this.middlewares,
      errorHandler: this.errorHandler as any,
      finallyHandler: this.finallyHandler as any,
    });
  }

  public parallel<
    TMap extends Record<
      string,
      | Executable<any, any>
      | ConditionalExecutable<any, any, FlowContext<TInput, TSteps>>
      | { executable: Executable<any, any>; mapInput?: (ctx: FlowContext<TInput, TSteps>) => any }
    >,
  >(
    branches: TMap,
  ): FlowDef<
    TInput,
    TSteps & {
      [K in keyof TMap]: TMap[K] extends ConditionalExecutable<any, infer O, any>
        ? O | undefined
        : TMap[K] extends Executable<any, infer O>
          ? O
          : TMap[K] extends { executable: Executable<any, infer O> }
            ? O
            : unknown;
    }
  > {
    const node: FlowNode = {
      type: 'parallel',
      branches,
    };
    return new FlowDef(this.name, {
      inputSchema: this.inputSchema,
      nodes: [...this.nodes, node],
      middlewares: this.middlewares,
      errorHandler: this.errorHandler as any,
      finallyHandler: this.finallyHandler as any,
    });
  }

  public loop<TLoopSteps extends Record<string, any>>(config: {
    readonly maxIterations: number;
    readonly body: (round: FlowDef<TInput, TSteps>) => FlowDef<TInput, TSteps & TLoopSteps>;
    readonly until: (ctx: FlowContext<TInput, TSteps & TLoopSteps>) => boolean;
  }): FlowDef<TInput, TSteps & TLoopSteps> {
    const bodyFlow = config.body(
      new FlowDef<TInput, TSteps>(`${this.name}:loop`, { inputSchema: this.inputSchema }),
    );
    const node: FlowNode = {
      type: 'loop',
      maxIterations: config.maxIterations,
      bodyFlow,
      until: config.until,
    };
    return new FlowDef<TInput, TSteps & TLoopSteps>(this.name, {
      inputSchema: this.inputSchema,
      nodes: [...this.nodes, node],
      middlewares: this.middlewares,
      errorHandler: this.errorHandler as any,
      finallyHandler: this.finallyHandler as any,
    });
  }

  public batch<K extends string, TItem, TOut>(
    name: K,
    config: {
      readonly items: (
        ctx: FlowContext<TInput, TSteps>,
      ) => readonly TItem[] | Promise<readonly TItem[]>;
      readonly execute: Executable<TItem, TOut>;
      readonly concurrency?: number;
    },
  ): FlowDef<TInput, TSteps & Record<K, TOut[]>> {
    const node: FlowNode = {
      type: 'batch',
      name,
      items: config.items,
      execute: config.execute,
      concurrency: config.concurrency ?? 5,
    };
    return new FlowDef<TInput, TSteps & Record<K, TOut[]>>(this.name, {
      inputSchema: this.inputSchema,
      nodes: [...this.nodes, node],
      middlewares: this.middlewares,
      errorHandler: this.errorHandler as any,
      finallyHandler: this.finallyHandler as any,
    });
  }

  public haltIf(
    predicate: (ctx: FlowContext<TInput, TSteps>) => boolean,
    mapBlocker?: (ctx: FlowContext<TInput, TSteps>) => { reason: string } | string,
  ): FlowDef<TInput, TSteps> {
    const node: FlowNode = {
      type: 'haltIf',
      predicate,
      mapBlocker,
    };
    return new FlowDef<TInput, TSteps>(this.name, {
      inputSchema: this.inputSchema,
      nodes: [...this.nodes, node],
      middlewares: this.middlewares,
      errorHandler: this.errorHandler,
      finallyHandler: this.finallyHandler,
    });
  }

  public onError(
    handler: (error: unknown, ctx: FlowContext<TInput, TSteps>) => Promise<void> | void,
  ): FlowDef<TInput, TSteps> {
    return new FlowDef<TInput, TSteps>(this.name, {
      inputSchema: this.inputSchema,
      nodes: this.nodes,
      middlewares: this.middlewares,
      errorHandler: handler,
      finallyHandler: this.finallyHandler,
    });
  }

  public finally(
    handler: Executable<any, any> | ((ctx: FlowContext<TInput, TSteps>) => Promise<void> | void),
  ): FlowDef<TInput, TSteps> {
    return new FlowDef<TInput, TSteps>(this.name, {
      inputSchema: this.inputSchema,
      nodes: this.nodes,
      middlewares: this.middlewares,
      errorHandler: this.errorHandler,
      finallyHandler: handler,
    });
  }

  public async execute(input: TInput, ctx: ExecutionContext): Promise<TSteps> {
    const { FlowEngine } = await import('./engine.js');
    const engine = new FlowEngine(ctx.store);
    const result = await engine.run(this, input, {
      runId: ctx.runId,
      workDir: ctx.workDir,
      hookServerUrl: ctx.hookServerUrl,
      signal: ctx.signal,
    });
    return result.steps;
  }
}

export class HeadDef {
  public readonly capabilitySet: ReadonlySet<HeadCapability>;
  public readonly contextNoticeThresholdTokens: number;
  public readonly listenPort: number;
  public readonly customTools: ReadonlyMap<string, Executable<any, any>>;
  public readonly flows: ReadonlyMap<string, FlowDef<any, any>>;

  public constructor(opts?: {
    capabilitySet?: ReadonlySet<HeadCapability>;
    contextNoticeThresholdTokens?: number;
    listenPort?: number;
    customTools?: ReadonlyMap<string, Executable<any, any>>;
    flows?: ReadonlyMap<string, FlowDef<any, any>>;
  }) {
    this.capabilitySet = opts?.capabilitySet ?? new Set<HeadCapability>();
    this.contextNoticeThresholdTokens = opts?.contextNoticeThresholdTokens ?? 180_000;
    this.listenPort = opts?.listenPort ?? 4100;
    this.customTools = opts?.customTools ?? new Map();
    this.flows = opts?.flows ?? new Map();
  }

  public capabilities(caps: readonly HeadCapability[]): HeadDef {
    return new HeadDef({
      capabilitySet: new Set(caps),
      contextNoticeThresholdTokens: this.contextNoticeThresholdTokens,
      listenPort: this.listenPort,
      customTools: this.customTools,
      flows: this.flows,
    });
  }

  public contextNoticeThreshold(tokens: number): HeadDef {
    return new HeadDef({
      capabilitySet: this.capabilitySet,
      contextNoticeThresholdTokens: tokens,
      listenPort: this.listenPort,
      customTools: this.customTools,
      flows: this.flows,
    });
  }

  public port(listenPort: number): HeadDef {
    return new HeadDef({
      capabilitySet: this.capabilitySet,
      contextNoticeThresholdTokens: this.contextNoticeThresholdTokens,
      listenPort,
      customTools: this.customTools,
      flows: this.flows,
    });
  }

  public tool(name: string, executable: Executable<any, any>): HeadDef {
    const next = new Map(this.customTools);
    next.set(name, executable);
    return new HeadDef({
      capabilitySet: this.capabilitySet,
      contextNoticeThresholdTokens: this.contextNoticeThresholdTokens,
      listenPort: this.listenPort,
      customTools: next,
      flows: this.flows,
    });
  }

  public registerFlow(flow: FlowDef<any, any>): HeadDef {
    const next = new Map(this.flows);
    next.set(flow.name, flow);
    return new HeadDef({
      capabilitySet: this.capabilitySet,
      contextNoticeThresholdTokens: this.contextNoticeThresholdTokens,
      listenPort: this.listenPort,
      customTools: this.customTools,
      flows: next,
    });
  }
}

export const H = {
  drivers,
  account(id: string, driver: Driver): AccountDef {
    return new AccountDef(id, driver);
  },
  pool(id: string, accounts: readonly AccountDef[]): PoolDef {
    return new PoolDef(id, accounts);
  },
  model(
    accountOrPool: AccountProvider,
    modelId: string,
    options?: Record<string, unknown>,
  ): ModelDef {
    return new ModelDef(accountOrPool, modelId, options);
  },
  runner: {
    local(opts?: LocalRunnerOptions): LocalRunner {
      return new LocalRunner(opts);
    },
    ssh(id: string, opts: SshRunnerOptions): SshRunner {
      return new SshRunner(id, opts);
    },
  },
  command(name: string): CommandDef {
    return new CommandDef(name);
  },
  skill(name: string): SkillDef {
    return new SkillDef(name);
  },
  agent(name: string): AgentDef {
    return new AgentDef(name);
  },
  flow(name: string): FlowDef {
    return new FlowDef(name);
  },
  when<TInput, TOutput, TFlowCtx = any>(
    predicate: (ctx: TFlowCtx) => boolean,
    executable: Executable<TInput, TOutput>,
    mapInput?: (ctx: TFlowCtx) => TInput,
  ): ConditionalExecutable<TInput, TOutput, TFlowCtx> {
    return new ConditionalExecutable(
      predicate,
      executable,
      mapInput ??
        (executable instanceof BoundAgentSkill && executable.inputMapper
          ? executable.inputMapper
          : undefined),
    );
  },
  head(): HeadDef {
    return new HeadDef();
  },
};
