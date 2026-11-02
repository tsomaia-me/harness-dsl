import type { Entity, Named } from './refs.js';

export type Position = 'pending' | 'active' | 'waiting' | 'terminal';
export type Verdict = 'success' | 'failure' | 'neutral';
export type AttemptOutcome = 'succeeded' | 'failed' | 'cancelled';
export type AttemptStatus = 'running' | 'blocked';
export type BlockReason =
  | 'decision'
  | 'timer'
  | 'children'
  | 'job'
  | 'stepFailure'
  | 'budget'
  | 'interrupted'
  | 'definitionChanged';
export type ResolvedBy = 'human' | 'policy' | 'timeout';
export type LeaseMode = 'exclusive' | 'shared';
export type ServiceClass = 'expedite' | 'fixedDate' | 'standard';
export type LoopSpan = 'attempt' | 'unit';

export interface State<N extends string = string, P extends Position = Position> extends Entity<'state'> {
  readonly name: N;
  readonly position: P;
  readonly verdict?: Verdict;
}

export type KindRef = Entity<'kind'>;
export type LaneRef = Entity<'lane'>;
export type RoleRef = Entity<'role'>;
export type ResourceRef = Entity<'resource'>;
export type HaltRef = Entity<'halt'>;
export type SeatRef = Entity<'seat'>;
export type FacetRef = Entity<'facet'>;
export type JobRef = Entity<'job'>;
export type SignalRef = Entity<'signal'>;

export interface FacetValue<V extends string = string> {
  readonly facet: FacetRef;
  readonly value: V;
}

export interface StoredFacetValue {
  readonly facet: string;
  readonly value: string;
}

export interface StoredDimensions {
  readonly kind?: string;
  readonly lane?: string;
  readonly state?: string;
  readonly seat?: string;
  readonly model?: string;
  readonly resource?: string;
  readonly halt?: string;
  readonly facets?: readonly StoredFacetValue[];
}

export interface MetricRead {
  readonly metric: string;
  readonly dimensions: StoredDimensions;
  readonly value: number;
  readonly samples: number;
}

export type Measure = 'rate' | 'total';

export interface MetricRef<M extends Measure = Measure> extends Named {
  readonly entity: 'metric';
  readonly measure: M;
}
