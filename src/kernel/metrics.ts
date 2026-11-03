import type { FacetValue, HaltRef, JobRef, LaneRef, MetricRef, ResolvedBy, ResourceRef, SeatRef, State } from './lifecycle.js';
import type { Named } from './refs.js';

export interface Dimensions {
  readonly seat?: SeatRef;
  readonly model?: Named;
  readonly resource?: ResourceRef;
  readonly halt?: HaltRef;
  readonly facets?: readonly FacetValue[];
}

export type Window =
  | { readonly lastDays: number }
  | { readonly lastHours: number }
  | { readonly calendar: 'day' | 'week' | 'month'; readonly tz?: string };

export interface Rate {
  readonly rate: number;
  readonly hits: number;
  readonly samples: number;
}

export interface Total {
  readonly total: number;
  readonly samples: number;
}

export interface OutcomeCounts<S extends State = State> {
  readonly terminal: number;
  readonly success: number;
  readonly failure: number;
  readonly neutral: number;
  readonly successRate: number;
  readonly samples: number;
  count(state: S): number;
}

export interface AttemptCounts {
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly retried: number;
  readonly successRate: number;
  readonly samples: number;
}

export interface DecisionCounts {
  readonly samples: number;
  readonly medianMs: number;
  readonly byResolver: readonly {
    readonly resolvedBy: ResolvedBy;
    readonly resolver: string;
    readonly count: number;
    readonly medianMs: number;
  }[];
}

export interface LeaseWaits {
  readonly samples: number;
  readonly medianWaitMs: number;
  readonly totalWaitMs: number;
}

export interface PausedTime {
  readonly totalMs: number;
  readonly count: number;
}

export interface JobHours {
  readonly hoursInFlight: number;
  readonly inFlightNow: number;
  readonly samples: number;
}

export interface WorkScope<S extends State = State> extends Named {
  readonly entity: 'kind' | 'lane';
  readonly _states?: S;
}

export interface MetricQuery extends Dimensions {
  readonly of?: WorkScope;
  readonly window?: Window;
}

export interface Metrics {
  outcomes<S extends State>(query: { readonly of: WorkScope<S>; readonly window?: Window }): OutcomeCounts<S>;
  attempts(query: { readonly of: WorkScope; readonly seat?: SeatRef; readonly model?: Named; readonly window?: Window }): AttemptCounts;
  rate(metric: MetricRef<'rate'>, query?: MetricQuery): Rate;
  total(metric: MetricRef<'total'>, query?: MetricQuery): Total;
  paused(query: { readonly lane: LaneRef; readonly window?: Window }): PausedTime;
  decisions(query: { readonly halt: HaltRef; readonly window?: Window }): DecisionCounts;
  leases(query: { readonly resource: ResourceRef; readonly window?: Window }): LeaseWaits;
  jobs(query: { readonly job: JobRef; readonly window?: Window }): JobHours;
}
