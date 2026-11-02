import type { LaneDef } from '../dsl/lanes.js';
import type { DecisionEvent, InvocationEvent, StepEvent, TransitionEvent } from '../dsl/sources.js';
import type { UnitView } from '../dsl/views.js';
import type { LedgerEvent, State, UnitRecord } from '../kernel/index.js';

type AnyLane = LaneDef<unknown, State, unknown, string>;

export function stateOf(lane: AnyLane, name: string): State {
  const states = (lane.kind as { readonly stateList?: readonly State[] }).stateList ?? [];
  return states.find((state) => state.name === name) ?? { entity: 'state', name, position: 'pending' };
}

export function transitionEvent(lane: AnyLane, unit: UnitView<unknown>, event: Extract<LedgerEvent, { type: 'transition' }>, attempt?: { readonly durationMs: number; readonly costUsd: number }): TransitionEvent<unknown> {
  return {
    unit,
    ...(event.from !== undefined ? { from: stateOf(lane, event.from) } : {}),
    to: stateOf(lane, event.to),
    ...(attempt ? { attempt } : {}),
    at: event.at,
  };
}

export function stepEvent(unit: UnitView<unknown>, event: Extract<LedgerEvent, { type: 'stepEnded' }>): StepEvent<unknown, unknown> {
  return { unit, ok: event.ok, ...(event.output !== undefined ? { output: event.output } : {}), durationMs: event.durationMs, at: event.at };
}

export function decisionEvent(
  unit: UnitView<unknown>,
  event: Extract<LedgerEvent, { type: 'decisionRecorded' }>,
  waitedMs: number,
  modelsBySeat: ReadonlyMap<string, string>,
): DecisionEvent<unknown, State, unknown> {
  return {
    unit,
    halt: { entity: 'halt', name: event.halt, decisionSchema: undefined, decision: () => { throw new Error('a decision event carries a halt reference, not a builder'); } } as unknown as DecisionEvent<unknown, State, unknown>['halt'],
    decision: event.decision,
    resolvedBy: event.resolvedBy,
    resolver: event.by,
    facets: (event.facets ?? []).map((facet) => ({ facet: { entity: 'facet', name: facet.facet }, value: facet.value })),
    modelOf: (seat) => {
      const model = modelsBySeat.get(seat.name);
      return model ? { name: model } : undefined;
    },
    waitedMs,
    at: event.at,
  };
}

export function invocationEvent(event: Extract<LedgerEvent, { type: 'invocation' }>): InvocationEvent {
  return {
    ...(event.seat ? { seat: { name: event.seat } } : {}),
    ...(event.model ? { model: { name: event.model } } : {}),
    ok: event.ok,
    costUsd: event.costUsd,
    at: event.at,
  };
}

export function stepName(address: string): string {
  const last = address.split('/').pop() ?? address;
  return last.replace(/\[\d+\]$/, '');
}

export function inWindow(at: Date, now: Date, window: { readonly lastDays?: number; readonly lastHours?: number; readonly calendar?: 'day' | 'week' | 'month' } | undefined): boolean {
  if (!window) return true;
  if (window.lastDays !== undefined) return at.getTime() >= now.getTime() - window.lastDays * 86_400_000;
  if (window.lastHours !== undefined) return at.getTime() >= now.getTime() - window.lastHours * 3_600_000;
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  if (window.calendar === 'week') start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  if (window.calendar === 'month') start.setUTCDate(1);
  return at.getTime() >= start.getTime();
}

export function unitViewOf(record: UnitRecord, lane: AnyLane): UnitView<unknown> {
  const { statePosition: _position, attempt, ...unit } = record.unit;
  return {
    ...unit,
    kind: { entity: 'kind', name: record.unit.kind },
    lane: { entity: 'lane', name: record.unit.lane },
    state: stateOf(lane, record.unit.state),
    ...(attempt
      ? {
          attempt: {
            id: attempt.id,
            number: attempt.number,
            status: attempt.status,
            step: attempt.step,
            ...(attempt.blockedOn ? { blockedOn: attempt.blockedOn } : {}),
            ...(attempt.halt ? { halt: { entity: 'halt' as const, name: attempt.halt } } : {}),
            startedAt: attempt.startedAt,
          },
        }
      : {}),
  };
}
