import type { State } from '../kernel/lifecycle.js';
import type { Named } from '../kernel/refs.js';
import type { LaneAny, LaneShape } from './lanes.js';
import type { AdmitPolicyDef } from './policies.js';
import type { UnitView } from './views.js';

export interface SchedulerFields {
  readonly expedites: readonly { readonly lane: LaneAny; readonly holds: readonly LaneAny[] }[];
  readonly fixedDates: readonly { readonly lane: LaneAny; readonly due: (unit: UnitView<unknown>) => Date }[];
  readonly standards: readonly LaneAny[];
  readonly wips: readonly { readonly lanes: readonly LaneAny[]; readonly max: number }[];
  readonly agings: readonly { readonly lane: LaneAny; readonly afterMinutes: number }[];
  readonly admits: readonly { readonly lane: LaneAny; readonly policy: AdmitPolicyDef<unknown> }[];
}

const EMPTY: SchedulerFields = { expedites: [], fixedDates: [], standards: [], wips: [], agings: [], admits: [] };

export class SchedulerDef implements Named, SchedulerFields {
  public readonly entity = 'scheduler' as const;
  public readonly name: string;
  public readonly expedites: SchedulerFields['expedites'];
  public readonly fixedDates: SchedulerFields['fixedDates'];
  public readonly standards: SchedulerFields['standards'];
  public readonly wips: SchedulerFields['wips'];
  public readonly agings: SchedulerFields['agings'];
  public readonly admits: SchedulerFields['admits'];

  public constructor(name: string, fields: SchedulerFields = EMPTY) {
    this.name = name;
    this.expedites = fields.expedites;
    this.fixedDates = fields.fixedDates;
    this.standards = fields.standards;
    this.wips = fields.wips;
    this.agings = fields.agings;
    this.admits = fields.admits;
  }

  private with(patch: Partial<SchedulerFields>): SchedulerDef {
    return new SchedulerDef(this.name, { expedites: this.expedites, fixedDates: this.fixedDates, standards: this.standards, wips: this.wips, agings: this.agings, admits: this.admits, ...patch });
  }

  public expedite(lane: LaneAny, options?: { readonly holds?: readonly LaneAny[] }): SchedulerDef {
    return this.with({ expedites: [...this.expedites, { lane, holds: options?.holds ?? [] }] });
  }

  public fixedDate<A>(lane: LaneShape<A, State, unknown>, due: (unit: UnitView<A>) => Date): SchedulerDef {
    return this.with({ fixedDates: [...this.fixedDates, { lane: lane as LaneAny, due: due as (unit: UnitView<unknown>) => Date }] });
  }

  public standard(...lanes: readonly LaneAny[]): SchedulerDef {
    return this.with({ standards: [...this.standards, ...lanes] });
  }

  public wip(lanes: LaneAny | readonly LaneAny[], max: number): SchedulerDef {
    return this.with({ wips: [...this.wips, { lanes: Array.isArray(lanes) ? (lanes as readonly LaneAny[]) : [lanes as LaneAny], max }] });
  }

  public aging(lane: LaneAny, aging: { readonly afterMinutes: number }): SchedulerDef {
    return this.with({ agings: [...this.agings, { lane, afterMinutes: aging.afterMinutes }] });
  }

  public admit<A>(lane: LaneShape<A, State, unknown>, policy: AdmitPolicyDef<A>): SchedulerDef {
    return this.with({ admits: [...this.admits, { lane: lane as LaneAny, policy: policy as AdmitPolicyDef<unknown> }] });
  }
}

export function scheduler(name: string): SchedulerDef {
  return new SchedulerDef(name);
}
