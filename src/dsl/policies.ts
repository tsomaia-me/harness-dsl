import type { Model } from '../kernel/backends.js';
import type { FacetValue, KindRef, Position, SeatRef, State } from '../kernel/lifecycle.js';
import type { MemoryItem } from '../kernel/backends.js';
import type { Metrics } from '../kernel/metrics.js';
import type { AccountState } from '../kernel/quota.js';
import type { Named } from '../kernel/refs.js';
import type { HaltDef } from './halts.js';
import type { KindShape } from './kinds.js';
import type { RecallCandidate } from './memory.js';
import type { RunnerDef } from './runners.js';
import type { UnitView } from './views.js';

export interface PolicyDef<C, R> extends Named {
  readonly entity: 'policy';
  readonly policy: string;
  decide(ctx: C): R;
}

export interface ModelPolicyCtx {
  readonly kind: KindRef;
  readonly seat: SeatRef;
  readonly current?: Model;
  readonly peers: readonly { readonly seat: SeatRef; readonly model: Model }[];
  readonly metrics: Metrics;
}

export interface ModelPolicyDef<D extends string = string> extends PolicyDef<ModelPolicyCtx, Model<D>> {
  readonly policy: 'model';
  readonly candidates: readonly Model<D>[];
  readonly distinct: boolean;
  readonly _driver?: D;
}

export interface AccountPolicyCtx {
  readonly candidates: readonly AccountState[];
  readonly now: Date;
}

export interface AccountPolicyDef extends PolicyDef<AccountPolicyCtx, AccountState | undefined> {
  readonly policy: 'account';
}

export interface RunnerPolicyCtx<A = unknown> {
  readonly candidates: readonly RunnerDef[];
  readonly unit: UnitView<A>;
  readonly metrics: Metrics;
}

export interface RunnerPolicyDef<A = unknown> extends PolicyDef<RunnerPolicyCtx<A>, RunnerDef> {
  readonly policy: 'runner';
  readonly candidates: readonly RunnerDef[];
}

export interface HaltPolicyCtx<A> {
  readonly unit: UnitView<A>;
  readonly facets: readonly FacetValue[];
  readonly metrics: Metrics;
}

export interface HaltPolicyDef<A, D> extends PolicyDef<HaltPolicyCtx<A>, D | undefined> {
  readonly policy: 'halt';
  readonly kind: KindShape<A, State>;
  readonly halt: HaltDef<string, D>;
}

export interface RecallCtx {
  readonly candidates: readonly RecallCandidate[];
  readonly limit: number;
}

export interface RecallPolicyDef extends PolicyDef<RecallCtx, readonly MemoryItem[]> {
  readonly policy: 'recall';
}

export interface AdmitCtx<A> {
  readonly unit: UnitView<A>;
  readonly count: (lanes: Named | readonly Named[], ...positions: Position[]) => number;
  readonly metrics: Metrics;
}

export interface AdmitPolicyDef<A = unknown> extends PolicyDef<AdmitCtx<A>, boolean> {
  readonly policy: 'admit';
}

export const policy = {
  model<D extends string>(
    name: string,
    candidates: readonly Model<D>[],
    choose: (ctx: ModelPolicyCtx) => Model<D>,
    options?: { readonly distinct?: boolean },
  ): ModelPolicyDef<D> {
    return { entity: 'policy', policy: 'model', name, candidates, distinct: options?.distinct ?? false, decide: choose };
  },
  account(name: string, choose: (ctx: AccountPolicyCtx) => AccountState | undefined): AccountPolicyDef {
    return { entity: 'policy', policy: 'account', name, decide: choose };
  },
  runner<A = unknown>(name: string, candidates: readonly RunnerDef[], choose: (ctx: RunnerPolicyCtx<A>) => RunnerDef): RunnerPolicyDef<A> {
    return { entity: 'policy', policy: 'runner', name, candidates, decide: choose };
  },
  halt<A, S extends State, D>(name: string, kind: KindShape<A, S>, halt: HaltDef<string, D>): { decide(decide: (ctx: HaltPolicyCtx<A>) => D | undefined): HaltPolicyDef<A, D> } {
    return {
      decide: (decide) => ({ entity: 'policy', policy: 'halt', name, kind: kind as KindShape<A, State>, halt, decide }),
    };
  },
  recall(name: string, choose: (ctx: RecallCtx) => readonly MemoryItem[]): RecallPolicyDef {
    return { entity: 'policy', policy: 'recall', name, decide: choose };
  },
  admit<A = unknown>(name: string, decide: (ctx: AdmitCtx<A>) => boolean): AdmitPolicyDef<A> {
    return { entity: 'policy', policy: 'admit', name, decide };
  },
};
