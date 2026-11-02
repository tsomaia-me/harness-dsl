import type { Executable } from './executables.js';
import type { Schema } from './kinds.js';
import type { RunnerPolicyDef } from './policies.js';
import type { RunnerDef } from './runners.js';

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type Effect = 'repeatable' | 'unrepeatable' | 'external';

export interface DetectCtx<I> {
  readonly input: I;
  exec(argv: readonly string[]): Promise<CommandResult>;
}

export class CommandDef<I = void, O = CommandResult> implements Executable<I, O> {
  public readonly entity = 'command' as const;
  public readonly name: string;
  public readonly inputSchema: Schema<I> | undefined;
  public readonly outputSchema: Schema<O> | undefined;
  public readonly argvOf: ((input: I) => readonly string[]) | undefined;
  public readonly runnerChoice: RunnerDef | RunnerPolicyDef | undefined;
  public readonly acceptedExitCodes: readonly number[];
  public readonly effectKind: Effect;
  public readonly detect: ((ctx: DetectCtx<I>) => Promise<boolean>) | undefined;
  public readonly _io?: { readonly in: (input: I) => void; readonly out: O };

  public constructor(
    name: string,
    fields: {
      readonly inputSchema?: Schema<I>;
      readonly outputSchema?: Schema<O>;
      readonly argvOf?: (input: I) => readonly string[];
      readonly runnerChoice?: RunnerDef | RunnerPolicyDef;
      readonly acceptedExitCodes?: readonly number[];
      readonly effectKind?: Effect;
      readonly detect?: (ctx: DetectCtx<I>) => Promise<boolean>;
    } = {},
  ) {
    this.name = name;
    this.inputSchema = fields.inputSchema;
    this.outputSchema = fields.outputSchema;
    this.argvOf = fields.argvOf;
    this.runnerChoice = fields.runnerChoice;
    this.acceptedExitCodes = fields.acceptedExitCodes ?? [0];
    this.effectKind = fields.effectKind ?? 'repeatable';
    this.detect = fields.detect;
  }

  private fields(): {
    readonly inputSchema?: Schema<I>;
    readonly outputSchema?: Schema<O>;
    readonly argvOf?: (input: I) => readonly string[];
    readonly runnerChoice?: RunnerDef | RunnerPolicyDef;
    readonly acceptedExitCodes?: readonly number[];
    readonly effectKind?: Effect;
    readonly detect?: (ctx: DetectCtx<I>) => Promise<boolean>;
  } {
    return {
      inputSchema: this.inputSchema,
      outputSchema: this.outputSchema,
      argvOf: this.argvOf,
      runnerChoice: this.runnerChoice,
      acceptedExitCodes: this.acceptedExitCodes,
      effectKind: this.effectKind,
      detect: this.detect,
    };
  }

  public input<I2>(schema: Schema<I2>): CommandDef<I2, O> {
    return new CommandDef<I2, O>(this.name, {
      outputSchema: this.outputSchema,
      runnerChoice: this.runnerChoice,
      acceptedExitCodes: this.acceptedExitCodes,
      effectKind: this.effectKind,
      inputSchema: schema,
    });
  }

  public output<O2>(schema: Schema<O2>): CommandDef<I, O2> {
    return new CommandDef<I, O2>(this.name, {
      inputSchema: this.inputSchema,
      argvOf: this.argvOf,
      runnerChoice: this.runnerChoice,
      acceptedExitCodes: this.acceptedExitCodes,
      effectKind: this.effectKind,
      detect: this.detect,
      outputSchema: schema,
    });
  }

  public argv(argv: readonly string[] | ((input: I) => readonly string[])): CommandDef<I, O> {
    return new CommandDef<I, O>(this.name, { ...this.fields(), argvOf: typeof argv === 'function' ? argv : () => argv });
  }

  public runner(choice: RunnerDef | RunnerPolicyDef): CommandDef<I, O> {
    return new CommandDef<I, O>(this.name, { ...this.fields(), runnerChoice: choice });
  }

  public acceptExitCodes(...codes: readonly number[]): CommandDef<I, O> {
    return new CommandDef<I, O>(this.name, { ...this.fields(), acceptedExitCodes: codes });
  }

  public effect(kind: 'repeatable' | 'unrepeatable'): CommandDef<I, O>;
  public effect(kind: 'external', detect: (ctx: DetectCtx<I>) => Promise<boolean>): CommandDef<I, O>;
  public effect(kind: Effect, detect?: (ctx: DetectCtx<I>) => Promise<boolean>): CommandDef<I, O> {
    return new CommandDef<I, O>(this.name, { ...this.fields(), effectKind: kind, detect: kind === 'external' ? detect : undefined });
  }
}

export function command(name: string): CommandDef<void, CommandResult> {
  return new CommandDef(name);
}
