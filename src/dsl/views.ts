import type { AttemptStatus, BlockReason, HaltRef, KindRef, LaneRef, Position, State, Verdict } from '../kernel/lifecycle.js';

export interface AttemptView {
  readonly id: string;
  readonly number: number;
  readonly status: AttemptStatus;
  readonly step: string;
  readonly blockedOn?: BlockReason;
  readonly halt?: HaltRef;
  readonly startedAt: Date;
}

export interface UnitView<A = unknown, S extends State = State> {
  readonly id: string;
  readonly key: string;
  readonly kind: KindRef;
  readonly lane: LaneRef;
  readonly state: S;
  readonly position: Position;
  readonly verdict?: Verdict;
  readonly attributes: A;
  readonly createdAt: Date;
  readonly costUsd: number;
  readonly attempts: number;
  readonly failedAttempts: number;
  readonly attempt?: AttemptView;
}

export interface ChildResult {
  readonly unitId: string;
  readonly state: State;
  readonly verdict?: Verdict;
}
