import type { LaneDef } from '../dsl/lanes.js';
import type { FacetDef } from '../dsl/resources.js';
import type { Band, CrossingEvent, PatternEvent, UnitEvent } from '../dsl/sources.js';
import { actions, type AnyTrigger, type Effect } from '../dsl/triggers.js';
import type { LedgerEvent, MetricRef, State, UnitRecord } from '../kernel/index.js';
import type { Json, JsonObject } from '../kernel/refs.js';
import { stateOf, unitViewOf } from './events.js';
import type { LedgerMetrics } from './metrics.js';
import type { Runtime } from './runtime.js';

type AnyLane = LaneDef<unknown, State, unknown, string>;

interface Streak {
  count: number;
}

interface TimerMemo {
  state: 'armed' | 'cleared' | 'fired';
  fireAtMs: number;
}

export class TriggerEngine {
  private cursor = 0;
  private readonly streaks = new Map<string, Streak>();
  private readonly bands = new Map<string, { inside: boolean }>();
  private readonly timers = new Map<string, TimerMemo>();
  private primed = false;

  public constructor(
    private readonly runtime: Runtime,
    private readonly metrics: LedgerMetrics,
  ) {}

  private get triggers(): readonly AnyTrigger[] {
    return this.runtime.harness.triggerList;
  }

  public async prime(): Promise<void> {
    let last = 0;
    let marker: number | undefined;
    const history: { readonly seq: number; readonly event: LedgerEvent }[] = [];
    for await (const row of this.runtime.ledger.read({})) {
      last = row.seq;
      history.push(row);
      if (row.event.type === 'triggersProcessed') marker = row.event.upToSeq;
    }
    this.cursor = marker ?? last;
    for (const { seq, event } of history) {
      this.remember(event);
      if (event.type === 'transition' && seq <= this.cursor) await this.trackStreak(event);
    }
    this.primed = true;
  }

  private remember(event: LedgerEvent): void {
    if (event.type === 'crossing') this.bands.set(`${event.metric}:${event.band}:${event.group ? `${event.group.facet}=${event.group.value}` : ''}`, { inside: event.edge === 'entered' });
    if (event.type === 'timerSet') this.timers.set(event.timerId, { state: 'armed', fireAtMs: event.fireAt.getTime() });
    if (event.type === 'timerCleared') this.timers.set(event.timerId, { state: 'cleared', fireAtMs: this.timers.get(event.timerId)?.fireAtMs ?? 0 });
    if (event.type === 'timerFired') this.timers.set(event.timerId, { state: 'fired', fireAtMs: this.timers.get(event.timerId)?.fireAtMs ?? 0 });
  }

  private async located(unitId: string): Promise<{ readonly lane: AnyLane; readonly record: UnitRecord } | undefined> {
    const record = await this.runtime.find(unitId);
    if (!record) return undefined;
    const lane = this.runtime.harness.laneList.find((candidate) => candidate.name === record.unit.lane) as AnyLane | undefined;
    return lane ? { lane, record } : undefined;
  }

  private async trackStreak(event: Extract<LedgerEvent, { type: 'transition' }>): Promise<readonly { readonly trigger: AnyTrigger; readonly count: number }[]> {
    const fired: { readonly trigger: AnyTrigger; readonly count: number }[] = [];
    const located = await this.located(event.unitId);
    if (!located) return fired;
    for (const trigger of this.triggers) {
      const spec = trigger.source?.spec;
      if (spec?.on !== 'pattern' || spec.lane.name !== located.lane.name) continue;
      const group = spec.per(unitViewOf(located.record, located.lane));
      const key = `${trigger.name}:${group.facet.name}=${group.value}`;
      const matches = spec.to.some((state) => state.name === event.to);
      const streak = this.streaks.get(key) ?? { count: 0 };
      streak.count = matches ? streak.count + 1 : 0;
      this.streaks.set(key, streak);
      if (matches && streak.count === spec.consecutive) fired.push({ trigger, count: streak.count });
    }
    return fired;
  }

  public async process(): Promise<void> {
    if (!this.primed) await this.prime();
    let handled = false;
    while (true) {
      const fresh: { readonly seq: number; readonly event: LedgerEvent }[] = [];
      for await (const row of this.runtime.ledger.read({ afterSeq: this.cursor })) fresh.push(row);
      if (fresh.length === 0) break;
      for (const { seq, event } of fresh) {
        this.cursor = seq;
        this.remember(event);
        if (event.type === 'triggersProcessed') continue;
        handled = true;
        await this.fire(seq, event);
      }
    }
    await this.evaluateCrossings();
    if (handled) {
      const seqs = await this.runtime.append([{ type: 'triggersProcessed', upToSeq: this.cursor, at: this.runtime.now() }]);
      this.cursor = Math.max(this.cursor, ...seqs);
    }
  }

  private async fire(seq: number, event: LedgerEvent): Promise<void> {
    switch (event.type) {
      case 'transition': {
        const located = await this.located(event.unitId);
        if (!located) return;
        const { lane, record } = located;
        const view = unitViewOf(record, lane);
        for (const trigger of this.triggers) {
          const spec = trigger.source?.spec;
          if (spec?.on === 'transition' && spec.lane.name === lane.name && (!spec.to || spec.to.some((state) => state.name === event.to))) {
            const typed = { unit: view, ...(event.from !== undefined ? { from: stateOf(lane, event.from) } : {}), to: stateOf(lane, event.to), at: event.at };
            if (spec.if && !spec.if(typed)) continue;
            await this.consequences(trigger, seq, typed);
          }
        }
        for (const { trigger, count } of await this.trackStreak(event)) {
          const spec = trigger.source!.spec;
          if (spec.on !== 'pattern') continue;
          const typed: PatternEvent<unknown, State, string> = { unit: view, to: stateOf(lane, event.to), at: event.at, group: spec.per(view), streak: count };
          await this.consequences(trigger, seq, typed);
        }
        if (event.position === 'terminal') await this.clearTimers(event.unitId);
        else await this.armTimers(event.unitId);
        return;
      }
      case 'unitCreated':
      case 'attributesUpdated': {
        if (event.type === 'attributesUpdated' && !event.applied) return;
        await this.armTimers(event.unitId);
        return;
      }
      case 'timerFired': {
        for (const trigger of this.triggers) {
          const spec = trigger.source?.spec;
          if (spec?.on !== 'timer' || event.timerId !== `trigger:${trigger.name}:${event.unitId}`) continue;
          const located = await this.located(event.unitId);
          if (!located) continue;
          const typed: UnitEvent<unknown> = { unit: unitViewOf(located.record, located.lane), at: event.at };
          await this.consequences(trigger, seq, typed);
        }
        return;
      }
      case 'stepEnded':
      case 'decisionRecorded':
      case 'invocation': {
        await this.metrics.refresh();
        for (const trigger of this.triggers) {
          const spec = trigger.source?.spec;
          if (!spec || (spec.on !== 'step' && spec.on !== 'decision' && spec.on !== 'invocation')) continue;
          for (const typed of this.metrics.typedEvents(trigger.source!)) {
            if (typed.seq !== seq) continue;
            await this.consequences(trigger, seq, typed.event);
          }
        }
        return;
      }
      default:
        return;
    }
  }

  private async armTimers(unitId: string): Promise<void> {
    const located = await this.located(unitId);
    if (!located || located.record.unit.position === 'terminal') return;
    const { lane, record } = located;
    for (const trigger of this.triggers) {
      const spec = trigger.source?.spec;
      if (spec?.on !== 'timer' || spec.lane.name !== lane.name) continue;
      const timerId = `trigger:${trigger.name}:${unitId}`;
      const fireAt = spec.at(unitViewOf(record, lane));
      const existing = this.timers.get(timerId);
      const at = this.runtime.now();
      if (fireAt === undefined) {
        if (existing?.state === 'armed') {
          await this.runtime.append([{ type: 'timerCleared', timerId, reason: 'disarmed', at }]);
          this.timers.set(timerId, { state: 'cleared', fireAtMs: existing.fireAtMs });
        }
        continue;
      }
      if (existing?.state === 'armed' && existing.fireAtMs === fireAt.getTime()) continue;
      await this.runtime.append([
        { type: 'timerSet', timerId, unitId, owner: `trigger:${trigger.name}`, fireAt, reason: existing?.state === 'armed' ? 'moved' : 'armed', ...(existing?.state === 'armed' ? { previousFireAt: new Date(existing.fireAtMs) } : {}), at },
      ]);
      this.timers.set(timerId, { state: 'armed', fireAtMs: fireAt.getTime() });
    }
  }

  private async clearTimers(unitId: string): Promise<void> {
    for (const trigger of this.triggers) {
      const spec = trigger.source?.spec;
      if (spec?.on !== 'timer') continue;
      const timerId = `trigger:${trigger.name}:${unitId}`;
      const existing = this.timers.get(timerId);
      if (existing?.state === 'armed') {
        await this.runtime.append([{ type: 'timerCleared', timerId, reason: 'unitTerminal', at: this.runtime.now() }]);
        this.timers.set(timerId, { state: 'cleared', fireAtMs: existing.fireAtMs });
      }
    }
  }

  private async evaluateCrossings(): Promise<void> {
    await this.metrics.refresh();
    const watched = new Map<string, { readonly metric: MetricRef<'rate'>; readonly band: Band; readonly per?: FacetDef<string>; readonly triggers: AnyTrigger[] }>();
    for (const trigger of this.triggers) {
      const spec = trigger.source?.spec;
      if (spec?.on !== 'crossing') continue;
      const bandId = `${spec.metric.name}:${JSON.stringify(spec.band)}:${spec.per?.name ?? ''}`;
      const entry = watched.get(bandId) ?? { metric: spec.metric, band: spec.band, ...(spec.per ? { per: spec.per } : {}), triggers: [] };
      entry.triggers.push(trigger);
      watched.set(bandId, entry);
    }
    for (const [bandId, { metric, band, per, triggers }] of watched) {
      const groups: (string | undefined)[] = per ? [...per.values] : [undefined];
      for (const group of groups) {
        const facets = per && group !== undefined ? [per.of(group)] : [];
        const value = this.metrics.rate(metric, { window: band.window, facets });
        if (value.samples < band.minSamples) continue;
        const key = `${metric.name}:${bandId}:${per && group !== undefined ? `${per.name}=${group}` : ''}`;
        const state = this.bands.get(key) ?? { inside: false };
        const crossedIn = !state.inside && ('below' in band.enter ? value.rate < band.enter.below : value.rate > band.enter.above);
        const crossedOut = state.inside && ('above' in band.exit ? value.rate > band.exit.above : value.rate < band.exit.below);
        if (!crossedIn && !crossedOut) continue;
        state.inside = crossedIn;
        this.bands.set(key, state);
        const edge = crossedIn ? 'entered' : 'exited';
        const at = this.runtime.now();
        const seqs = await this.runtime.append([
          { type: 'crossing', metric: metric.name, band: bandId, ...(per && group !== undefined ? { group: { facet: per.name, value: group } } : {}), edge, rate: value.rate, hits: value.hits, samples: value.samples, at },
        ]);
        this.cursor = Math.max(this.cursor, ...seqs);
        const typed: CrossingEvent & { readonly group?: { readonly facet: { readonly entity: 'facet'; readonly name: string }; readonly value: string } } = {
          rate: value.rate,
          hits: value.hits,
          samples: value.samples,
          at,
          ...(per && group !== undefined ? { group: per.of(group) } : {}),
        };
        for (const trigger of triggers) {
          const spec = trigger.source!.spec;
          if (spec.on === 'crossing' && spec.edge === edge) await this.consequences(trigger, this.cursor, typed);
        }
      }
    }
  }

  private async consequences(trigger: AnyTrigger, sourceSeq: number, event: unknown): Promise<void> {
    const produced = trigger.consequence!(event as never, actions);
    const effects: readonly Effect[] = produced === undefined ? [] : Array.isArray(produced) ? (produced as readonly Effect[]) : [produced as Effect];
    const at = this.runtime.now();
    for (const effect of effects) {
      switch (effect.effect) {
        case 'create': {
          const created = await this.runtime.createUnit(effect.lane, effect.attrs, { source: `trigger:${trigger.name}` });
          await this.runtime.append([{ type: 'triggerFired', trigger: trigger.name, sourceSeq, consequence: 'create', targetId: created ?? effect.lane.name, result: created ? 'applied' : 'deduped', at }]);
          break;
        }
        case 'signal':
          await this.runtime.deliverSignal(effect.lane.name, effect.key, effect.signal.name, effect.payload as Json, `trigger:${trigger.name}`);
          await this.runtime.append([{ type: 'triggerFired', trigger: trigger.name, sourceSeq, consequence: 'signal', targetId: effect.key, result: 'applied', at }]);
          break;
        case 'pause':
          await this.runtime.append([
            { type: 'lanePaused', lane: effect.lane.name, reason: effect.reason, by: `trigger:${trigger.name}`, at },
            { type: 'triggerFired', trigger: trigger.name, sourceSeq, consequence: 'pause', targetId: effect.lane.name, result: 'applied', at },
          ]);
          break;
        case 'resume':
          await this.runtime.append([
            { type: 'laneResumed', lane: effect.lane.name, reason: effect.reason, by: `trigger:${trigger.name}`, at },
            { type: 'triggerFired', trigger: trigger.name, sourceSeq, consequence: 'resume', targetId: effect.lane.name, result: 'applied', at },
          ]);
          break;
        case 'record':
          await this.runtime.recordMemory(effect.journal, effect.draft, `trigger:${trigger.name}`);
          await this.runtime.append([{ type: 'triggerFired', trigger: trigger.name, sourceSeq, consequence: 'record', targetId: effect.journal.name, result: 'applied', at }]);
          break;
        case 'run':
          await this.runtime.runExecutable(effect.exec, effect.input as JsonObject);
          await this.runtime.append([{ type: 'triggerFired', trigger: trigger.name, sourceSeq, consequence: 'run', targetId: effect.exec.name, result: 'applied', at }]);
          break;
      }
    }
  }
}
