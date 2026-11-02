import type { Client, Observer } from '../kernel/backends.js';
import type { Ledger } from '../kernel/events.js';
import type { Account } from '../kernel/quota.js';
import type { Named } from '../kernel/refs.js';
import type { LaneAny } from './lanes.js';
import type { JournalDef } from './memory.js';
import type { AnyMetric } from './metrics.js';
import type { SchedulerDef } from './scheduler.js';
import type { AnyTrigger } from './triggers.js';

export interface HarnessFields {
  readonly ledgerDef?: Ledger;
  readonly laneList: readonly LaneAny[];
  readonly journalList: readonly JournalDef[];
  readonly triggerList: readonly AnyTrigger[];
  readonly metricList: readonly AnyMetric[];
  readonly schedulerDef?: SchedulerDef;
  readonly clientList: readonly Client[];
  readonly observerList: readonly Observer[];
  readonly shares: readonly { readonly account: Account; readonly fraction: number }[];
}

const EMPTY: HarnessFields = { laneList: [], journalList: [], triggerList: [], metricList: [], clientList: [], observerList: [], shares: [] };

export class HarnessDef implements Named {
  public readonly entity = 'harness' as const;
  public readonly name: string;
  public readonly ledgerDef: Ledger | undefined;
  public readonly laneList: HarnessFields['laneList'];
  public readonly journalList: HarnessFields['journalList'];
  public readonly triggerList: HarnessFields['triggerList'];
  public readonly metricList: HarnessFields['metricList'];
  public readonly schedulerDef: SchedulerDef | undefined;
  public readonly clientList: HarnessFields['clientList'];
  public readonly observerList: HarnessFields['observerList'];
  public readonly shares: HarnessFields['shares'];

  public constructor(name: string, fields: HarnessFields = EMPTY) {
    this.name = name;
    this.ledgerDef = fields.ledgerDef;
    this.laneList = fields.laneList;
    this.journalList = fields.journalList;
    this.triggerList = fields.triggerList;
    this.metricList = fields.metricList;
    this.schedulerDef = fields.schedulerDef;
    this.clientList = fields.clientList;
    this.observerList = fields.observerList;
    this.shares = fields.shares;
  }

  private fields(): HarnessFields {
    return {
      ledgerDef: this.ledgerDef,
      laneList: this.laneList,
      journalList: this.journalList,
      triggerList: this.triggerList,
      metricList: this.metricList,
      schedulerDef: this.schedulerDef,
      clientList: this.clientList,
      observerList: this.observerList,
      shares: this.shares,
    };
  }

  private with(patch: Partial<HarnessFields>): HarnessDef {
    return new HarnessDef(this.name, { ...this.fields(), ...patch });
  }

  public ledger(ledger: Ledger): HarnessDef {
    return this.with({ ledgerDef: ledger });
  }

  public lanes(...lanes: readonly LaneAny[]): HarnessDef {
    return this.with({ laneList: [...this.laneList, ...lanes] });
  }

  public journals(...journals: readonly JournalDef[]): HarnessDef {
    return this.with({ journalList: [...this.journalList, ...journals] });
  }

  public triggers(...triggers: readonly AnyTrigger[]): HarnessDef {
    return this.with({ triggerList: [...this.triggerList, ...triggers] });
  }

  public metrics(...metrics: readonly AnyMetric[]): HarnessDef {
    return this.with({ metricList: [...this.metricList, ...metrics] });
  }

  public scheduler(scheduler: SchedulerDef): HarnessDef {
    return this.with({ schedulerDef: scheduler });
  }

  public clients(...clients: readonly Client[]): HarnessDef {
    return this.with({ clientList: [...this.clientList, ...clients] });
  }

  public observers(...observers: readonly Observer[]): HarnessDef {
    return this.with({ observerList: [...this.observerList, ...observers] });
  }

  public share(account: Account, fraction: number): HarnessDef {
    return this.with({ shares: [...this.shares, { account, fraction }] });
  }
}

export function harness(name: string): HarnessDef {
  return new HarnessDef(name);
}
