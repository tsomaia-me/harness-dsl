import type { Store, Supplier } from '../kernel/backends.js';
import type { LeaseMode, State } from '../kernel/lifecycle.js';
import type { WorkScope } from '../kernel/metrics.js';
import type { FlowDef, Retry } from './flows.js';
import type { HaltDef } from './halts.js';
import type { Empty, KindShape, TerminalState, WaitingState } from './kinds.js';
import type { ResourceDef } from './resources.js';
import type { SignalDef } from './halts.js';
import type { UnitView } from './views.js';

export interface LaneShape<A, S extends State, St> extends WorkScope<S> {
  readonly entity: 'lane';
  readonly _types?: { readonly attrs: A; readonly states: S; readonly steps: St };
}

export type LaneAny = LaneShape<unknown, State, unknown>;

export type InputFits<A, I> = [A] extends [I] ? unknown : { readonly flowInputDoesNotFitKind: I };

export interface Route {
  readonly route: 'create' | 'signal' | 'skip';
  readonly attrs?: unknown;
  readonly signal?: SignalDef<string, unknown>;
  readonly key?: string;
  readonly payload?: unknown;
}

export interface Router<A> {
  create(attrs: A): Route;
  signal<P>(signal: SignalDef<string, P>, key: string, payload: P): Route;
  skip(): Route;
}

export interface OperatorSupplier {
  readonly entity: 'operator';
  readonly name: 'operator';
}

export const operator: OperatorSupplier = { entity: 'operator', name: 'operator' };

export interface Supply {
  readonly supplier: Supplier<unknown> | OperatorSupplier;
  readonly route?: (event: unknown, to: Router<unknown>) => Route | readonly Route[];
}

export type RetryPolicy<S extends State> = Retry & {
  readonly exhausted?: TerminalState<S> | { readonly state: WaitingState<S>; readonly reopenAfter: { readonly minutes?: number; readonly hours?: number; readonly days?: number } };
};

export interface Reaction<A, S extends State, N extends string, P> {
  readonly update?: (attrs: A, payload: P) => A;
  readonly rewind?: N;
  readonly enter?: S;
  readonly at?: readonly N[];
}

export interface StoreMap<S extends State, M extends string> {
  readonly states: { readonly [K in S['name']]: M };
}

export interface Lease {
  readonly resource: ResourceDef;
  readonly mode: LeaseMode;
}

export interface Ceiling {
  readonly maxUsd: number;
  readonly onExceed: HaltDef<string, unknown>;
}

export interface Handler {
  readonly flow: FlowDef<unknown, unknown, unknown, string, string>;
  readonly exits: Readonly<Record<string, State>>;
  readonly params?: unknown;
}

export class LaneDef<A = Empty, S extends State = never, St = Empty, N extends string = never> implements LaneShape<A, S, St> {
  public readonly entity = 'lane' as const;
  public readonly name: string;
  public readonly kind: KindShape<A, S>;
  public readonly supplies: readonly Supply[];
  public readonly handlerDef: Handler | undefined;
  public readonly storeDef: Store<string> | undefined;
  public readonly storeMap: StoreMap<S, string> | undefined;
  public readonly retryPolicy: RetryPolicy<S> | undefined;
  public readonly leaseOf: ((unit: UnitView<A, S>) => Lease) | undefined;
  public readonly order: { readonly key: (attrs: A) => string | undefined; readonly onPredecessorFailed: WaitingState<S> } | undefined;
  public readonly reactions: readonly { readonly signal: SignalDef<string, unknown>; readonly reaction: Reaction<A, S, N, unknown> }[];
  public readonly ceilingOf: Ceiling | undefined;
  public readonly _types?: { readonly attrs: A; readonly states: S; readonly steps: St; readonly stepNames: N };
  public readonly _states?: S;

  public constructor(
    name: string,
    kind: KindShape<A, S>,
    fields: {
      readonly supplies?: readonly Supply[];
      readonly handlerDef?: Handler;
      readonly storeDef?: Store<string>;
      readonly storeMap?: StoreMap<S, string>;
      readonly retryPolicy?: RetryPolicy<S>;
      readonly leaseOf?: (unit: UnitView<A, S>) => Lease;
      readonly order?: { readonly key: (attrs: A) => string | undefined; readonly onPredecessorFailed: WaitingState<S> };
      readonly reactions?: readonly { readonly signal: SignalDef<string, unknown>; readonly reaction: Reaction<A, S, N, unknown> }[];
      readonly ceilingOf?: Ceiling;
    } = {},
  ) {
    this.name = name;
    this.kind = kind;
    this.supplies = fields.supplies ?? [];
    this.handlerDef = fields.handlerDef;
    this.storeDef = fields.storeDef;
    this.storeMap = fields.storeMap;
    this.retryPolicy = fields.retryPolicy;
    this.leaseOf = fields.leaseOf;
    this.order = fields.order;
    this.reactions = fields.reactions ?? [];
    this.ceilingOf = fields.ceilingOf;
  }

  private fields() {
    return {
      supplies: this.supplies,
      handlerDef: this.handlerDef,
      storeDef: this.storeDef,
      storeMap: this.storeMap,
      retryPolicy: this.retryPolicy,
      leaseOf: this.leaseOf,
      order: this.order,
      reactions: this.reactions,
      ceilingOf: this.ceilingOf,
    };
  }

  private with<St2 = St, N2 extends string = N>(patch: Partial<ReturnType<LaneDef<A, S, St, N>['fields']>>): LaneDef<A, S, St2, N2> {
    const fields = { ...this.fields(), ...patch } as unknown as ConstructorParameters<typeof LaneDef<A, S, St2, N2>>[2];
    return new LaneDef<A, S, St2, N2>(this.name, this.kind, fields);
  }

  public supply(supplier: OperatorSupplier): LaneDef<A, S, St, N>;
  public supply<E>(supplier: Supplier<E>, route: (event: E, to: Router<A>) => Route | readonly Route[]): LaneDef<A, S, St, N>;
  public supply<E>(supplier: Supplier<E> | OperatorSupplier, route?: (event: E, to: Router<A>) => Route | readonly Route[]): LaneDef<A, S, St, N> {
    const supply: Supply = route
      ? { supplier: supplier as Supplier<unknown>, route: route as (event: unknown, to: Router<unknown>) => Route | readonly Route[] }
      : { supplier };
    return this.with({ supplies: [...this.supplies, supply] });
  }

  public handler<I, St2, X extends string, N2 extends string>(
    flow: FlowDef<I, void, St2, X, N2>,
    map: { readonly exits: { readonly [K in X]: S } } & InputFits<A, I>,
  ): LaneDef<A, S, St2, N2>;
  public handler<I, P, St2, X extends string, N2 extends string>(
    flow: FlowDef<I, P, St2, X, N2>,
    map: { readonly exits: { readonly [K in X]: S }; readonly params: P } & InputFits<A, I>,
  ): LaneDef<A, S, St2, N2>;
  public handler<I, P, St2, X extends string, N2 extends string>(
    flow: FlowDef<I, P, St2, X, N2>,
    map: { readonly exits: { readonly [K in X]: S }; readonly params?: P },
  ): LaneDef<A, S, St2, N2> {
    return this.with<St2, N2>({
      handlerDef: { flow: flow as FlowDef<unknown, unknown, unknown, string, string>, exits: map.exits as Readonly<Record<string, State>>, params: map.params },
    });
  }

  public store(store: Store<never>): LaneDef<A, S, St, N>;
  public store<M extends string>(store: Store<M>, map: StoreMap<S, M>): LaneDef<A, S, St, N>;
  public store<M extends string>(store: Store<M>, map?: StoreMap<S, M>): LaneDef<A, S, St, N> {
    return this.with({ storeDef: store as Store<string>, storeMap: map as StoreMap<S, string> | undefined });
  }

  public retry(retryPolicy: RetryPolicy<S>): LaneDef<A, S, St, N> {
    return this.with({ retryPolicy });
  }

  public lease(leaseOf: (unit: UnitView<A, S>) => Lease): LaneDef<A, S, St, N> {
    return this.with({ leaseOf });
  }

  public after(order: { readonly key: (attrs: A) => string | undefined; readonly onPredecessorFailed: WaitingState<S> }): LaneDef<A, S, St, N> {
    return this.with({ order });
  }

  public on<P>(signal: SignalDef<string, P>, reaction: Reaction<A, S, N, P>): LaneDef<A, S, St, N> {
    return this.with({
      reactions: [...this.reactions, { signal: signal as SignalDef<string, unknown>, reaction: reaction as Reaction<A, S, N, unknown> }],
    });
  }

  public ceiling(ceilingOf: Ceiling): LaneDef<A, S, St, N> {
    return this.with({ ceilingOf });
  }
}

export function lane<A, S extends State>(name: string, kind: KindShape<A, S>): LaneDef<A, S, Empty, never> {
  return new LaneDef<A, S, Empty, never>(name, kind);
}
