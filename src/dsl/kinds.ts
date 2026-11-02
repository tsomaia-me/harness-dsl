import type { z } from 'zod';
import type { Position, State, Verdict } from '../kernel/lifecycle.js';
import type { WorkScope } from '../kernel/metrics.js';

export type Schema<T> = z.ZodType<T>;
export type Empty = { readonly [K in never]: never };

export type PendingState<S extends State> = Extract<S, State<string, 'pending'>>;
export type WaitingState<S extends State> = Extract<S, State<string, 'waiting'>>;
export type TerminalState<S extends State> = Extract<S, State<string, 'terminal'>>;

export interface StateDef<N extends string = string, P extends Position = Position> extends State<N, P> {}

export function state<N extends string, P extends 'pending' | 'waiting'>(name: N, position: P): StateDef<N, P> {
  return { entity: 'state', name, position };
}

export function terminal<N extends string>(name: N, verdict: Verdict): StateDef<N, 'terminal'> {
  return { entity: 'state', name, position: 'terminal', verdict };
}

export interface KindShape<A, S extends State> extends WorkScope<S> {
  readonly entity: 'kind';
  readonly _types?: { readonly attrs: A; readonly states: S };
}

export class KindDef<N extends string = string, A = Empty, S extends State = never> implements KindShape<A, S> {
  public readonly entity = 'kind' as const;
  public readonly name: N;
  public readonly attributeSchema: Schema<A> | undefined;
  public readonly stateList: readonly S[];
  public readonly keyOf: ((attrs: A) => string) | undefined;
  public readonly initialState: PendingState<S> | undefined;
  public readonly _types?: { readonly attrs: A; readonly states: S };
  public readonly _states?: S;

  public constructor(
    name: N,
    fields: {
      readonly attributeSchema?: Schema<A>;
      readonly stateList?: readonly S[];
      readonly keyOf?: (attrs: A) => string;
      readonly initialState?: PendingState<S>;
    } = {},
  ) {
    this.name = name;
    this.attributeSchema = fields.attributeSchema;
    this.stateList = fields.stateList ?? [];
    this.keyOf = fields.keyOf;
    this.initialState = fields.initialState;
  }

  public attributes<A2 extends object>(schema: Schema<A2>): KindDef<N, A2, S> {
    return new KindDef<N, A2, S>(this.name, { attributeSchema: schema, stateList: this.stateList });
  }

  public states<S2 extends readonly State[]>(...states: S2): KindDef<N, A, S2[number]> {
    return new KindDef<N, A, S2[number]>(this.name, {
      attributeSchema: this.attributeSchema,
      stateList: states,
      keyOf: this.keyOf,
    });
  }

  public key(keyOf: (attrs: A) => string): KindDef<N, A, S> {
    return new KindDef<N, A, S>(this.name, {
      attributeSchema: this.attributeSchema,
      stateList: this.stateList,
      keyOf,
      initialState: this.initialState,
    });
  }

  public initial(state: PendingState<S>): KindDef<N, A, S> {
    return new KindDef<N, A, S>(this.name, {
      attributeSchema: this.attributeSchema,
      stateList: this.stateList,
      keyOf: this.keyOf,
      initialState: state,
    });
  }
}

export function kind<N extends string>(name: N): KindDef<N, Empty, never> {
  return new KindDef(name);
}
