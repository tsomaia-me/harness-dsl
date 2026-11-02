import type { FacetValue, MetricRef, ResolvedBy, State } from '../kernel/lifecycle.js';
import type { Window } from '../kernel/metrics.js';
import type { Named } from '../kernel/refs.js';
import type { HaltDef } from './halts.js';
import type { KindShape } from './kinds.js';
import type { LaneAny, LaneShape } from './lanes.js';
import type { FacetDef } from './resources.js';
import type { UnitView } from './views.js';

export interface TransitionEvent<A, S extends State = State> {
  readonly unit: UnitView<A, S>;
  readonly from?: S;
  readonly to: S;
  readonly attempt?: { readonly durationMs: number; readonly costUsd: number };
  readonly at: Date;
}

export interface PatternEvent<A, S extends State, V extends string> extends TransitionEvent<A, S> {
  readonly group: FacetValue<V>;
  readonly streak: number;
}

export interface UnitEvent<A, S extends State = State> {
  readonly unit: UnitView<A, S>;
  readonly at: Date;
}

export interface StepEvent<A, O> {
  readonly unit: UnitView<A>;
  readonly ok: boolean;
  readonly output?: O;
  readonly durationMs: number;
  readonly at: Date;
}

export interface DecisionEvent<A, S extends State, D> {
  readonly unit: UnitView<A, S>;
  readonly halt: HaltDef<string, D>;
  readonly decision: D;
  readonly resolvedBy: ResolvedBy;
  readonly resolver: string;
  readonly facets: readonly FacetValue[];
  readonly modelOf: (seat: Named) => Named | undefined;
  readonly waitedMs: number;
  readonly at: Date;
}

export interface InvocationEvent {
  readonly seat?: Named;
  readonly model?: Named;
  readonly ok: boolean;
  readonly costUsd: number;
  readonly at: Date;
}

export type Threshold = { readonly below: number } | { readonly above: number };

export interface Band {
  readonly window: Window;
  readonly minSamples: number;
  readonly enter: Threshold;
  readonly exit: Threshold;
}

export interface CrossingEvent {
  readonly rate: number;
  readonly hits: number;
  readonly samples: number;
  readonly at: Date;
}

export interface GroupCrossingEvent<V extends string> extends CrossingEvent {
  readonly group: FacetValue<V>;
}

export type StateMatch<S extends State> = S | readonly S[];

export type SourceSpec =
  | { readonly on: 'transition'; readonly lane: LaneAny; readonly to?: readonly State[]; readonly if?: (event: unknown) => boolean }
  | { readonly on: 'pattern'; readonly lane: LaneAny; readonly to: readonly State[]; readonly consecutive: number; readonly per: (unit: UnitView<unknown>) => FacetValue }
  | { readonly on: 'timer'; readonly lane: LaneAny; readonly at: (unit: UnitView<unknown>) => Date | undefined }
  | { readonly on: 'step'; readonly lane: LaneAny; readonly step: string; readonly if?: (event: unknown) => boolean }
  | { readonly on: 'decision'; readonly kind: KindShape<unknown, State>; readonly halt: HaltDef<string, unknown> }
  | { readonly on: 'invocation'; readonly lanes: readonly LaneAny[] }
  | { readonly on: 'crossing'; readonly metric: MetricRef<'rate'>; readonly band: Band; readonly per?: FacetDef<string>; readonly edge: 'entered' | 'exited' };

export interface Source<E> extends Named {
  readonly entity: 'source';
  readonly spec: SourceSpec;
  readonly _event?: E;
}

function source<E>(name: string, spec: SourceSpec): Source<E> {
  return { entity: 'source', name, spec };
}

function matches<S extends State>(to: StateMatch<S> | undefined): readonly State[] | undefined {
  return to === undefined ? undefined : Array.isArray(to) ? (to as readonly State[]) : [to as State];
}

export const when = {
  transition<A, S extends State, St>(
    lane: LaneShape<A, S, St>,
    filter?: { readonly to?: StateMatch<NoInfer<S>>; readonly if?: (event: TransitionEvent<A, S>) => boolean },
  ): Source<TransitionEvent<A, S>> {
    return source(`${lane.name}:transition`, {
      on: 'transition',
      lane: lane as LaneAny,
      ...(filter?.to !== undefined ? { to: matches(filter.to) } : {}),
      ...(filter?.if ? { if: filter.if as (event: unknown) => boolean } : {}),
    });
  },
  pattern<A, S extends State, St, V extends string>(
    lane: LaneShape<A, S, St>,
    pattern: { readonly to: StateMatch<NoInfer<S>>; readonly consecutive: number; readonly per: (unit: UnitView<A, S>) => FacetValue<V> },
  ): Source<PatternEvent<A, S, V>> {
    return source(`${lane.name}:pattern`, {
      on: 'pattern',
      lane: lane as LaneAny,
      to: matches(pattern.to)!,
      consecutive: pattern.consecutive,
      per: pattern.per as unknown as (unit: UnitView<unknown>) => FacetValue,
    });
  },
  timer<A, S extends State, St>(lane: LaneShape<A, S, St>, timer: { readonly at: (unit: UnitView<A, S>) => Date | undefined }): Source<UnitEvent<A, S>> {
    return source(`${lane.name}:timer`, { on: 'timer', lane: lane as LaneAny, at: timer.at as (unit: UnitView<unknown>) => Date | undefined });
  },
  step<A, S extends State, St, M extends keyof St & string>(
    lane: LaneShape<A, S, St>,
    step: M,
    filter?: { readonly if?: (event: StepEvent<A, St[M]>) => boolean },
  ): Source<StepEvent<A, St[M]>> {
    return source(`${lane.name}:step:${step}`, { on: 'step', lane: lane as LaneAny, step, ...(filter?.if ? { if: filter.if as (event: unknown) => boolean } : {}) });
  },
  decision<A, S extends State, D>(kind: KindShape<A, S>, halt: HaltDef<string, D>): Source<DecisionEvent<A, S, D>> {
    return source(`${kind.name}:decision:${halt.name}`, { on: 'decision', kind: kind as KindShape<unknown, State>, halt: halt as HaltDef<string, unknown> });
  },
  invocation(filter: { readonly lanes: readonly LaneAny[] }): Source<InvocationEvent> {
    return source(`invocation:${filter.lanes.map((lane) => lane.name).join(',')}`, { on: 'invocation', lanes: filter.lanes });
  },
  crossing,
};

function crossing<V extends string>(metric: MetricRef<'rate'>, band: Band & { readonly per: FacetDef<V> }, edge: 'entered' | 'exited'): Source<GroupCrossingEvent<V>>;
function crossing(metric: MetricRef<'rate'>, band: Band, edge: 'entered' | 'exited'): Source<CrossingEvent>;
function crossing(metric: MetricRef<'rate'>, band: Band & { readonly per?: FacetDef<string> }, edge: 'entered' | 'exited'): Source<CrossingEvent> {
  const { per, ...rest } = band;
  return source(`${metric.name}:crossing:${edge}`, { on: 'crossing', metric, band: rest, ...(per ? { per } : {}), edge });
}
