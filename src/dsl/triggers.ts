import type { Named } from '../kernel/refs.js';
import type { Executable } from './executables.js';
import type { SignalDef } from './halts.js';
import type { LaneAny, LaneShape } from './lanes.js';
import type { JournalDef, MemoryDraft } from './memory.js';
import type { Source } from './sources.js';
import type { State } from '../kernel/lifecycle.js';

export type Effect =
  | { readonly effect: 'create'; readonly lane: LaneAny; readonly attrs: unknown }
  | { readonly effect: 'signal'; readonly signal: SignalDef<string, unknown>; readonly lane: LaneAny; readonly key: string; readonly payload: unknown }
  | { readonly effect: 'record'; readonly journal: JournalDef; readonly draft: MemoryDraft }
  | { readonly effect: 'pause'; readonly lane: LaneAny; readonly reason: string }
  | { readonly effect: 'resume'; readonly lane: LaneAny; readonly reason: string }
  | { readonly effect: 'run'; readonly exec: Executable<unknown, unknown>; readonly input: unknown };

export interface Actions {
  create<A>(lane: LaneShape<A, State, unknown>, attrs: A): Effect;
  signal<P>(signal: SignalDef<string, P>, lane: LaneAny, target: { readonly key: string; readonly payload: P }): Effect;
  record(journal: JournalDef, draft: MemoryDraft): Effect;
  pause(lane: LaneAny, reason: string): Effect;
  resume(lane: LaneAny, reason: string): Effect;
  run<I>(exec: Executable<I, unknown>, input: I): Effect;
}

export const actions: Actions = {
  create: (lane, attrs) => ({ effect: 'create', lane: lane as LaneAny, attrs }),
  signal: (signal, lane, target) => ({ effect: 'signal', signal: signal as SignalDef<string, unknown>, lane, key: target.key, payload: target.payload }),
  record: (journal, draft) => ({ effect: 'record', journal, draft }),
  pause: (lane, reason) => ({ effect: 'pause', lane, reason }),
  resume: (lane, reason) => ({ effect: 'resume', lane, reason }),
  run: (exec, input) => ({ effect: 'run', exec: exec as Executable<unknown, unknown>, input }),
};

export type Consequence<E> = (event: E, act: Actions) => Effect | readonly Effect[] | undefined;

export interface AnyTrigger extends Named {
  readonly entity: 'trigger';
  readonly source: Source<unknown> | undefined;
  readonly consequence: Consequence<never> | undefined;
}

export class TriggerDef<E = never> implements Named {
  public readonly entity = 'trigger' as const;
  public readonly name: string;
  public readonly source: Source<E> | undefined;
  public readonly consequence: Consequence<E> | undefined;

  public constructor(name: string, source?: Source<E>, consequence?: Consequence<E>) {
    this.name = name;
    this.source = source;
    this.consequence = consequence;
  }

  public on<E2>(source: Source<E2>): TriggerDef<E2> {
    return new TriggerDef<E2>(this.name, source);
  }

  public do(consequence: Consequence<E>): TriggerDef<E> {
    return new TriggerDef<E>(this.name, this.source, consequence);
  }
}

export function trigger(name: string): TriggerDef<never> {
  return new TriggerDef(name);
}
