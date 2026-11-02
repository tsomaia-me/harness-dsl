import type { RoleRef } from '../kernel/lifecycle.js';
import type { Empty, Schema } from './kinds.js';

export type Intent = 'read' | 'edit' | 'run' | 'search' | 'browse' | 'halt' | 'record';

export class RoleDef<I = Empty, O = Empty> implements RoleRef {
  public readonly entity = 'role' as const;
  public readonly name: string;
  public readonly inputSchema: Schema<I> | undefined;
  public readonly outputSchema: Schema<O> | undefined;
  public readonly render: ((input: I) => string) | undefined;
  public readonly intentList: readonly Intent[];
  public readonly _io?: { readonly in: (input: I) => void; readonly out: O };

  public constructor(
    name: string,
    fields: {
      readonly inputSchema?: Schema<I>;
      readonly outputSchema?: Schema<O>;
      readonly render?: (input: I) => string;
      readonly intentList?: readonly Intent[];
    } = {},
  ) {
    this.name = name;
    this.inputSchema = fields.inputSchema;
    this.outputSchema = fields.outputSchema;
    this.render = fields.render;
    this.intentList = fields.intentList ?? [];
  }

  public input<I2>(schema: Schema<I2>): RoleDef<I2, O> {
    return new RoleDef<I2, O>(this.name, { inputSchema: schema, outputSchema: this.outputSchema, intentList: this.intentList });
  }

  public output<O2>(schema: Schema<O2>): RoleDef<I, O2> {
    return new RoleDef<I, O2>(this.name, { inputSchema: this.inputSchema, outputSchema: schema, render: this.render, intentList: this.intentList });
  }

  public prompt(render: (input: I) => string): RoleDef<I, O> {
    return new RoleDef<I, O>(this.name, { inputSchema: this.inputSchema, outputSchema: this.outputSchema, render, intentList: this.intentList });
  }

  public intents(...intents: Intent[]): RoleDef<I, O> {
    return new RoleDef<I, O>(this.name, { inputSchema: this.inputSchema, outputSchema: this.outputSchema, render: this.render, intentList: intents });
  }
}

export function role(name: string): RoleDef<Empty, Empty> {
  return new RoleDef(name);
}
