import type { FacetValue, LoopSpan, MetricRef, State } from '../kernel/lifecycle.js';
import type { MetricQuery, Rate, Total } from '../kernel/metrics.js';
import type { Named } from '../kernel/refs.js';
import type { Executable } from './executables.js';
import type { HaltDef } from './halts.js';
import type { Empty, Schema } from './kinds.js';
import type { LaneShape } from './lanes.js';
import type { HaltPolicyDef } from './policies.js';
import type { ResourceSetDef } from './resources.js';
import type { WorkspaceDef } from './runners.js';
import type { ChildResult, UnitView } from './views.js';

export interface FlowCtx<In, P, St> {
  readonly unit: UnitView<In>;
  readonly params: P;
  readonly steps: St;
  readonly now: Date;
  readonly iteration: number;
}

export interface Retry {
  readonly tries: number;
  readonly backoff?: 'fixed' | 'exponential';
  readonly initialDelayMs?: number;
}

export interface StepOptions {
  readonly retry?: Retry;
  readonly workspace?: WorkspaceDef;
  readonly guard?: { readonly leases?: ResourceSetDef<string>; readonly beforeStop?: Executable<void, unknown> };
  readonly halts?: readonly HaltDef<string, unknown>[];
}

export interface HaltOptions<In, P, St, D> {
  readonly ask: (ctx: FlowCtx<In, P, St>) => string;
  readonly skip?: HaltPolicyDef<In, D>;
  readonly facets?: (ctx: FlowCtx<In, P, St>) => readonly FacetValue[];
  readonly timeout?: { readonly afterMinutes: number; readonly decide: (ctx: FlowCtx<In, P, St>) => D };
  readonly escalate?: { readonly afterMinutes: number; readonly run: Executable<void, unknown> };
}

export interface LoopBounds<In, P, St, St2> {
  readonly max?: number | ((ctx: FlowCtx<In, P, St>) => number);
  readonly until?: (ctx: FlowCtx<In, P, St2>) => boolean;
  readonly span?: LoopSpan;
}

export type ParallelBranch<In, P, St> =
  | Executable<void, unknown>
  | { readonly exec: Executable<unknown, unknown>; readonly input: (ctx: FlowCtx<In, P, St>) => unknown };

type BranchOutput<B> = B extends { readonly exec: Executable<unknown, infer O> } ? O : B extends Executable<void, infer O> ? O : never;

type AnyCtx = FlowCtx<unknown, unknown, Record<string, unknown>>;

export type FlowNode =
  | { readonly type: 'step'; readonly name: string; readonly exec: Executable<unknown, unknown>; readonly input?: (ctx: AnyCtx) => unknown; readonly options: StepOptions }
  | { readonly type: 'halt'; readonly name: string; readonly halt: HaltDef<string, unknown>; readonly options: HaltOptions<unknown, unknown, Record<string, unknown>, unknown>; readonly when?: (ctx: AnyCtx) => boolean }
  | { readonly type: 'read'; readonly name: string; readonly metric: MetricRef; readonly query?: (ctx: AnyCtx) => MetricQuery }
  | { readonly type: 'spawn'; readonly name: string; readonly lane: LaneShape<unknown, State, unknown>; readonly children: (ctx: AnyCtx) => readonly unknown[] }
  | { readonly type: 'wait'; readonly name: string; readonly ms: number }
  | { readonly type: 'when'; readonly name: string; readonly predicate: (ctx: AnyCtx) => boolean; readonly nodes: readonly FlowNode[] }
  | { readonly type: 'parallel'; readonly name: string; readonly branches: Readonly<Record<string, ParallelBranch<unknown, unknown, Record<string, unknown>>>> }
  | {
      readonly type: 'loop';
      readonly name: string;
      readonly carry?: { readonly schema: Schema<unknown>; readonly initial: unknown; readonly next: (ctx: AnyCtx) => unknown };
      readonly nodes: readonly FlowNode[];
      readonly bounds: LoopBounds<unknown, unknown, Record<string, unknown>, Record<string, unknown>>;
    }
  | { readonly type: 'exit'; readonly name: string; readonly when?: (ctx: AnyCtx) => boolean };

export class FlowDef<In = unknown, P = void, St = Empty, X extends string = never, N extends string = never> implements Named {
  public readonly entity = 'flow' as const;
  public readonly name: string;
  public readonly inputSchema: Schema<In> | undefined;
  public readonly paramsSchema: Schema<P> | undefined;
  public readonly nodes: readonly FlowNode[];
  public readonly _types?: {
    readonly input: (attrs: In) => void;
    readonly params: (params: P) => P;
    readonly steps: St;
    readonly exits: X;
    readonly stepNames: N;
  };

  public constructor(name: string, fields: { readonly inputSchema?: Schema<In>; readonly paramsSchema?: Schema<P>; readonly nodes?: readonly FlowNode[] } = {}) {
    this.name = name;
    this.inputSchema = fields.inputSchema;
    this.paramsSchema = fields.paramsSchema;
    this.nodes = fields.nodes ?? [];
  }

  private add<St2, X2 extends string, N2 extends string>(node: FlowNode): FlowDef<In, P, St2, X2, N2> {
    return new FlowDef<In, P, St2, X2, N2>(this.name, { inputSchema: this.inputSchema, paramsSchema: this.paramsSchema, nodes: [...this.nodes, node] });
  }

  private sub(name: string): FlowDef<In, P, St, never, never> {
    return new FlowDef<In, P, St, never, never>(`${this.name}/${name}`, { inputSchema: this.inputSchema, paramsSchema: this.paramsSchema });
  }

  public input<In2>(schema: Schema<In2>): FlowDef<In2, P, St, X, N> {
    return new FlowDef<In2, P, St, X, N>(this.name, { inputSchema: schema, paramsSchema: this.paramsSchema, nodes: this.nodes });
  }

  public params<P2>(schema: Schema<P2>): FlowDef<In, P2, St, X, N> {
    return new FlowDef<In, P2, St, X, N>(this.name, { inputSchema: this.inputSchema, paramsSchema: schema, nodes: this.nodes });
  }

  public step<M extends string, O>(name: M, exec: Executable<void, O>, options?: StepOptions): FlowDef<In, P, St & { readonly [K in M]: O }, X, N | M>;
  public step<M extends string, I, O>(
    name: M,
    exec: Executable<I, O>,
    input: (ctx: FlowCtx<In, P, St>) => I,
    options?: StepOptions,
  ): FlowDef<In, P, St & { readonly [K in M]: O }, X, N | M>;
  public step<M extends string, I, O>(
    name: M,
    exec: Executable<I, O>,
    inputOrOptions?: ((ctx: FlowCtx<In, P, St>) => I) | StepOptions,
    options?: StepOptions,
  ): FlowDef<In, P, St & { readonly [K in M]: O }, X, N | M> {
    const input = typeof inputOrOptions === 'function' ? (inputOrOptions as (ctx: AnyCtx) => unknown) : undefined;
    const resolved = typeof inputOrOptions === 'function' ? options : inputOrOptions;
    return this.add({ type: 'step', name, exec: exec as Executable<unknown, unknown>, ...(input ? { input } : {}), options: resolved ?? {} });
  }

  public halt<M extends string, D>(
    name: M,
    halt: HaltDef<string, D>,
    options: HaltOptions<In, P, St, NoInfer<D>> & { readonly when: (ctx: FlowCtx<In, P, St>) => boolean },
  ): FlowDef<In, P, St & { readonly [K in M]: D | undefined }, X, N | M>;
  public halt<M extends string, D>(name: M, halt: HaltDef<string, D>, options: HaltOptions<In, P, St, NoInfer<D>>): FlowDef<In, P, St & { readonly [K in M]: D }, X, N | M>;
  public halt<M extends string, D>(
    name: M,
    halt: HaltDef<string, D>,
    options: HaltOptions<In, P, St, D> & { readonly when?: (ctx: FlowCtx<In, P, St>) => boolean },
  ): FlowDef<In, P, St & { readonly [K in M]: D | undefined }, X, N | M> {
    const { when, ...rest } = options;
    return this.add({
      type: 'halt',
      name,
      halt: halt as HaltDef<string, unknown>,
      options: rest as HaltOptions<unknown, unknown, Record<string, unknown>, unknown>,
      ...(when ? { when: when as (ctx: AnyCtx) => boolean } : {}),
    });
  }

  public read<M extends string>(name: M, metric: MetricRef<'rate'>, query?: (ctx: FlowCtx<In, P, St>) => MetricQuery): FlowDef<In, P, St & { readonly [K in M]: Rate }, X, N | M>;
  public read<M extends string>(name: M, metric: MetricRef<'total'>, query?: (ctx: FlowCtx<In, P, St>) => MetricQuery): FlowDef<In, P, St & { readonly [K in M]: Total }, X, N | M>;
  public read<M extends string>(name: M, metric: MetricRef, query?: (ctx: FlowCtx<In, P, St>) => MetricQuery): FlowDef<In, P, St & { readonly [K in M]: Rate | Total }, X, N | M> {
    return this.add({ type: 'read', name, metric, ...(query ? { query: query as (ctx: AnyCtx) => MetricQuery } : {}) });
  }

  public spawn<M extends string, A2>(
    name: M,
    lane: LaneShape<A2, State, unknown>,
    children: (ctx: FlowCtx<In, P, St>) => readonly A2[],
  ): FlowDef<In, P, St & { readonly [K in M]: readonly ChildResult[] }, X, N | M> {
    return this.add({ type: 'spawn', name, lane: lane as LaneShape<unknown, State, unknown>, children: children as (ctx: AnyCtx) => readonly unknown[] });
  }

  public wait<M extends string>(name: M, wait: { readonly ms: number }): FlowDef<In, P, St & { readonly [K in M]: Date }, X, N | M> {
    return this.add({ type: 'wait', name, ms: wait.ms });
  }

  public when<M extends string, St2, X2 extends string, N2 extends string>(
    name: M,
    predicate: (ctx: FlowCtx<In, P, St>) => boolean,
    body: (flow: FlowDef<In, P, St, never, never>) => FlowDef<In, P, St2, X2, N2>,
  ): FlowDef<In, P, St & Partial<Omit<St2, keyof St>>, X | X2, N | M | N2> {
    const built = body(this.sub(name));
    return this.add({ type: 'when', name, predicate: predicate as (ctx: AnyCtx) => boolean, nodes: built.nodes });
  }

  public parallel<M extends string, B extends Readonly<Record<string, ParallelBranch<In, P, St>>>>(
    name: M,
    branches: B,
  ): FlowDef<In, P, St & { readonly [K in M]: { readonly [K2 in keyof B]: BranchOutput<B[K2]> } }, X, N | M> {
    return this.add({ type: 'parallel', name, branches: branches as Readonly<Record<string, ParallelBranch<unknown, unknown, Record<string, unknown>>>> });
  }

  public loop<M extends string, St2, X2 extends string, N2 extends string>(
    name: M,
    body: (round: FlowDef<In, P, St, never, never>) => FlowDef<In, P, St2, X2, N2>,
    bounds: LoopBounds<In, P, St, St2>,
  ): FlowDef<In, P, St2, X | X2, N | M | N2>;
  public loop<M extends string, C, St2, X2 extends string, N2 extends string>(
    name: M,
    carry: { readonly carry: Schema<C>; readonly initial: NoInfer<C> },
    body: (round: FlowDef<In, P, St & { readonly [K in M]: C }, never, never>) => FlowDef<In, P, St2, X2, N2>,
    bounds: LoopBounds<In, P, St, St2> & { readonly next: (ctx: FlowCtx<In, P, St2>) => C },
  ): FlowDef<In, P, St2, X | X2, N | M | N2>;
  public loop(name: string, carryOrBody: unknown, bodyOrBounds?: unknown, maybeBounds?: unknown): FlowDef<any, any, any, any, any> {
    type Body = (round: FlowDef<In, P, unknown, never, never>) => FlowDef<In, P, unknown, string, string>;
    type Bounds = LoopBounds<unknown, unknown, Record<string, unknown>, Record<string, unknown>>;
    if (typeof carryOrBody === 'function') {
      const built = (carryOrBody as Body)(this.sub(name) as FlowDef<In, P, unknown, never, never>);
      return this.add({ type: 'loop', name, nodes: built.nodes, bounds: bodyOrBounds as Bounds });
    }
    const carry = carryOrBody as { readonly carry: Schema<unknown>; readonly initial: unknown };
    const bounds = maybeBounds as Bounds & { readonly next: (ctx: AnyCtx) => unknown };
    const built = (bodyOrBounds as Body)(this.sub(name) as FlowDef<In, P, unknown, never, never>);
    return this.add({ type: 'loop', name, carry: { schema: carry.carry, initial: carry.initial, next: bounds.next }, nodes: built.nodes, bounds });
  }

  public exit<M extends string>(name: M, when?: (ctx: FlowCtx<In, P, St>) => boolean): FlowDef<In, P, St, X | M, N> {
    return this.add({ type: 'exit', name, ...(when ? { when: when as (ctx: AnyCtx) => boolean } : {}) });
  }
}

export function flow(name: string): FlowDef<unknown, void, Empty, never, never> {
  return new FlowDef(name);
}
