import type {
  AttemptOutcome,
  AttemptStatus,
  BlockReason,
  LeaseMode,
  LoopSpan,
  MetricRead,
  Position,
  ResolvedBy,
  ServiceClass,
  StoredFacetValue,
  Verdict,
} from './lifecycle.js';
import type { Json, JsonObject } from './refs.js';

export type LedgerEvent =
  | { readonly type: 'unitCreated'; readonly unitId: string; readonly lane: string; readonly kind: string; readonly key: string; readonly parentId?: string; readonly attributes: JsonObject; readonly source: string; readonly at: Date }
  | { readonly type: 'createSkipped'; readonly lane: string; readonly key: string; readonly openUnitId: string; readonly source: string; readonly at: Date }
  | { readonly type: 'attributesUpdated'; readonly unitId: string; readonly attributes: JsonObject; readonly by: string; readonly applied: boolean; readonly at: Date }
  | { readonly type: 'transition'; readonly unitId: string; readonly from?: string; readonly to: string; readonly position: Position; readonly verdict?: Verdict; readonly attemptId?: string; readonly cause: string; readonly at: Date }
  | { readonly type: 'demandGranted'; readonly lane: string; readonly unitId: string; readonly serviceClass: ServiceClass; readonly at: Date }
  | { readonly type: 'attemptStarted'; readonly unitId: string; readonly attemptId: string; readonly number: number; readonly fromStep: string; readonly flow: string; readonly flowVersion: string; readonly serviceClass: ServiceClass; readonly at: Date }
  | { readonly type: 'attemptBlocked'; readonly attemptId: string; readonly step: string; readonly on: BlockReason; readonly halt?: string; readonly ask?: string; readonly detail?: string; readonly facets?: readonly StoredFacetValue[]; readonly at: Date }
  | { readonly type: 'attemptResumed'; readonly attemptId: string; readonly step: string; readonly at: Date }
  | { readonly type: 'attemptRewound'; readonly attemptId: string; readonly from: string; readonly to: string; readonly signal: string; readonly at: Date }
  | { readonly type: 'attemptInterrupted'; readonly attemptId: string; readonly step: string; readonly holder: string; readonly at: Date }
  | { readonly type: 'attemptRecovered'; readonly attemptId: string; readonly action: 'restartFromTop' | 'abandon' | 'continue'; readonly by: string; readonly at: Date }
  | { readonly type: 'attemptEnded'; readonly attemptId: string; readonly outcome: AttemptOutcome; readonly exit?: string; readonly costUsd: number; readonly at: Date }
  | { readonly type: 'retryScheduled'; readonly unitId: string; readonly failedAttempts: number; readonly notBefore: Date; readonly at: Date }
  | { readonly type: 'loopIteration'; readonly unitId: string; readonly attemptId: string; readonly loop: string; readonly iteration: number; readonly span: LoopSpan; readonly carry?: Json; readonly at: Date }
  | { readonly type: 'decisionRecorded'; readonly attemptId: string; readonly step: string; readonly halt: string; readonly decision: Json; readonly resolvedBy: ResolvedBy; readonly by: string; readonly facets?: readonly StoredFacetValue[]; readonly reads?: readonly MetricRead[]; readonly at: Date }
  | { readonly type: 'haltNotAsked'; readonly attemptId: string; readonly step: string; readonly halt: string; readonly at: Date }
  | { readonly type: 'haltEscalated'; readonly attemptId: string; readonly step: string; readonly halt: string; readonly at: Date }
  | { readonly type: 'stepStarted'; readonly attemptId: string; readonly step: string; readonly iteration: number; readonly at: Date }
  | { readonly type: 'stepEnded'; readonly attemptId: string; readonly step: string; readonly iteration: number; readonly ok: boolean; readonly output?: Json; readonly durationMs: number; readonly at: Date }
  | { readonly type: 'metricRead'; readonly attemptId: string; readonly step: string; readonly iteration: number; readonly read: MetricRead; readonly at: Date }
  | { readonly type: 'invocation'; readonly attemptId: string; readonly step: string; readonly number: number; readonly executable: string; readonly seat?: string; readonly model?: string; readonly account?: string; readonly runner?: string; readonly viaJob: boolean; readonly ok: boolean; readonly costUsd: number; readonly tokens?: number; readonly sessionId?: string; readonly durationMs: number; readonly at: Date }
  | { readonly type: 'jobSubmitted'; readonly attemptId: string; readonly step: string; readonly job: string; readonly jobId: string; readonly requests: number; readonly at: Date }
  | { readonly type: 'jobCollected'; readonly attemptId: string; readonly step: string; readonly job: string; readonly jobId: string; readonly state: 'succeeded' | 'failed'; readonly at: Date }
  | { readonly type: 'policyDecision'; readonly unitId?: string; readonly attemptId?: string; readonly policy: string; readonly value: Json; readonly reads?: readonly MetricRead[]; readonly at: Date }
  | { readonly type: 'policyRefused'; readonly attemptId?: string; readonly policy: string; readonly reason: string; readonly kept: Json; readonly at: Date }
  | { readonly type: 'signalDelivered'; readonly unitId: string; readonly signal: string; readonly payload: Json; readonly source: string; readonly applied: readonly ('update' | 'rewind' | 'enter')[]; readonly gatedAtStep?: string; readonly at: Date }
  | { readonly type: 'signalSkipped'; readonly lane: string; readonly key: string; readonly signal: string; readonly source: string; readonly at: Date }
  | { readonly type: 'timerSet'; readonly timerId: string; readonly unitId: string; readonly owner: string; readonly fireAt: Date; readonly reason: 'armed' | 'moved'; readonly previousFireAt?: Date; readonly at: Date }
  | { readonly type: 'timerCleared'; readonly timerId: string; readonly reason: 'moved' | 'disarmed' | 'unitTerminal'; readonly at: Date }
  | { readonly type: 'timerFired'; readonly timerId: string; readonly unitId: string; readonly at: Date }
  | { readonly type: 'crossing'; readonly metric: string; readonly band: string; readonly group?: StoredFacetValue; readonly edge: 'entered' | 'exited'; readonly rate: number; readonly hits: number; readonly samples: number; readonly at: Date }
  | { readonly type: 'triggerFired'; readonly trigger: string; readonly sourceSeq: number; readonly consequence: 'create' | 'signal' | 'record' | 'pause' | 'resume' | 'run'; readonly targetId: string; readonly result: 'applied' | 'deduped'; readonly at: Date }
  | { readonly type: 'lanePaused'; readonly lane: string; readonly reason: string; readonly by: string; readonly at: Date }
  | { readonly type: 'laneResumed'; readonly lane: string; readonly reason: string; readonly by: string; readonly at: Date }
  | { readonly type: 'expediteHold'; readonly lane: string; readonly heldBy: string; readonly released: boolean; readonly at: Date }
  | { readonly type: 'orderHeld'; readonly unitId: string; readonly predecessorKey: string; readonly reason: string; readonly at: Date }
  | { readonly type: 'leaseTaken'; readonly attemptId: string; readonly resource: string; readonly mode: LeaseMode; readonly waitedMs: number; readonly at: Date }
  | { readonly type: 'leaseReleased'; readonly attemptId: string; readonly resource: string; readonly at: Date };

export type LedgerEventType = LedgerEvent['type'];

export interface SequencedEvent {
  readonly seq: number;
  readonly event: LedgerEvent;
}

export interface LedgerQuery {
  readonly afterSeq?: number;
  readonly unitId?: string;
  readonly attemptId?: string;
  readonly types?: readonly LedgerEventType[];
  readonly since?: Date;
}

export interface UnitQuery {
  readonly lane?: string;
  readonly position?: readonly Position[];
  readonly state?: readonly string[];
  readonly attemptStatus?: readonly AttemptStatus[];
  readonly key?: string;
}

export interface StoredAttempt {
  readonly id: string;
  readonly number: number;
  readonly status: AttemptStatus;
  readonly step: string;
  readonly blockedOn?: BlockReason;
  readonly halt?: string;
  readonly startedAt: Date;
}

export interface StoredUnit {
  readonly id: string;
  readonly key: string;
  readonly kind: string;
  readonly lane: string;
  readonly parentId?: string;
  readonly state: string;
  readonly statePosition: Position;
  readonly position: Position;
  readonly verdict?: Verdict;
  readonly attributes: JsonObject;
  readonly createdAt: Date;
  readonly costUsd: number;
  readonly attempts: number;
  readonly failedAttempts: number;
  readonly attempt?: StoredAttempt;
}

export interface LoopRecord {
  readonly iteration: number;
  readonly span: LoopSpan;
  readonly carry?: Json;
}

export interface UnitRecord {
  readonly unit: StoredUnit;
  readonly cursor?: { readonly step: string; readonly iteration: number; readonly flowVersion: string };
  readonly stepOutputs: Readonly<Record<string, Json>>;
  readonly loops: Readonly<Record<string, LoopRecord>>;
  readonly notBefore?: Date;
}

export interface DueTimer {
  readonly timerId: string;
  readonly unitId: string;
  readonly owner: string;
}

export interface WriterClaim {
  readonly acquired: boolean;
  readonly holder: string;
  readonly expiresAt: Date;
}

export interface Ledger {
  append(events: readonly LedgerEvent[], writer: string): Promise<readonly number[]>;
  read(query: LedgerQuery): AsyncIterable<SequencedEvent>;
  unit(id: string): Promise<UnitRecord | undefined>;
  units(query: UnitQuery): Promise<readonly UnitRecord[]>;
  dueTimers(now: Date): Promise<readonly DueTimer[]>;
  takeLease(attemptId: string, resource: string, mode: LeaseMode): Promise<boolean>;
  claimWriter(holder: string, ttlMs: number): Promise<WriterClaim>;
  releaseWriter(holder: string): Promise<void>;
  close(): void;
}
