import type { LaneDef } from '../dsl/lanes.js';
import type { State, UnitRecord } from '../kernel/index.js';
import { unitViewOf } from './events.js';
import type { Runtime } from './runtime.js';
import { recordingMetrics } from './metrics.js';

type AnyLane = LaneDef<unknown, State, unknown, string>;

export interface Granted {
  readonly lane: string;
  readonly unitId: string;
  readonly serviceClass: 'expedite' | 'fixedDate' | 'standard';
}

export async function computeDemand(runtime: Runtime): Promise<readonly Granted[]> {
  const scheduler = runtime.harness.schedulerDef;
  if (!scheduler) return [];
  const now = runtime.now();
  const all = await runtime.ledger.units({});
  const byLane = new Map<string, UnitRecord[]>();
  for (const record of all) {
    const list = byLane.get(record.unit.lane) ?? [];
    list.push(record);
    byLane.set(record.unit.lane, list);
  }
  const running = (laneNames: readonly string[]): number =>
    laneNames.reduce((count, name) => count + (byLane.get(name) ?? []).filter((record) => record.unit.attempt?.status === 'running').length, 0);
  const open = (name: string): boolean => (byLane.get(name) ?? []).some((record) => record.unit.position !== 'terminal');
  const paused = runtime.pausedLanes();
  const held = runtime.heldUnits();

  const heldLanes = new Set<string>();
  for (const { lane, holds } of scheduler.expedites) {
    if (open(lane.name)) for (const hold of holds) heldLanes.add(hold.name);
  }

  const capacity = new Map<string, number>();
  const groups = new Map<string, { readonly lanes: readonly string[]; readonly max: number }>();
  for (const { lanes, max } of scheduler.wips) {
    const names = lanes.map((lane) => lane.name);
    for (const name of names) groups.set(name, { lanes: names, max });
  }
  const ordered: { readonly lane: AnyLane; readonly serviceClass: Granted['serviceClass']; readonly due?: (record: UnitRecord) => number }[] = [
    ...scheduler.expedites.map((entry) => ({ lane: runtime.lane(entry.lane.name), serviceClass: 'expedite' as const })),
    ...scheduler.fixedDates.map((entry) => ({ lane: runtime.lane(entry.lane.name), serviceClass: 'fixedDate' as const, due: (record: UnitRecord) => entry.due(unitViewOf(record, runtime.lane(entry.lane.name))).getTime() })),
    ...scheduler.standards.map((lane) => ({ lane: runtime.lane(lane.name), serviceClass: 'standard' as const })),
  ];

  const granted: Granted[] = [];
  for (const { lane, serviceClass, due } of ordered) {
    if (paused.has(lane.name) || heldLanes.has(lane.name)) continue;
    const group = groups.get(lane.name);
    const key = group ? group.lanes.join('|') : lane.name;
    const used = capacity.get(key) ?? running(group ? group.lanes : [lane.name]);
    let free = group ? group.max - used : Number.POSITIVE_INFINITY;
    if (serviceClass === 'expedite') free = Number.POSITIVE_INFINITY;
    const aging = scheduler.agings.find((entry) => entry.lane.name === lane.name);
    const admit = scheduler.admits.find((entry) => entry.lane.name === lane.name);
    const candidates = (byLane.get(lane.name) ?? [])
      .filter((record) => record.unit.position === 'pending' && record.unit.attempt === undefined && !held.has(record.unit.id) && (record.notBefore === undefined || record.notBefore.getTime() <= now.getTime()))
      .map((record) => ({ record, starved: aging !== undefined && now.getTime() - record.unit.createdAt.getTime() >= aging.afterMinutes * 60_000 }))
      .sort((a, b) => {
        if (a.starved !== b.starved) return a.starved ? -1 : 1;
        if (due) return due(a.record) - due(b.record);
        return a.record.unit.createdAt.getTime() - b.record.unit.createdAt.getTime();
      });
    for (const { record } of candidates) {
      if (free <= 0) break;
      if (admit) {
        const { metrics, reads } = recordingMetrics(runtime.metrics);
        const allowed = admit.policy.decide({
          unit: unitViewOf(record, lane),
          count: (lanes, ...positions) => {
            const names = Array.isArray(lanes) ? (lanes as readonly { readonly name: string }[]).map((entry) => entry.name) : [(lanes as { readonly name: string }).name];
            return names.reduce((sum, name) => sum + (byLane.get(name) ?? []).filter((candidate) => positions.length === 0 || positions.includes(candidate.unit.position)).length, 0);
          },
          metrics,
        });
        await runtime.append([{ type: 'policyDecision', unitId: record.unit.id, policy: admit.policy.name, value: allowed, reads, at: now }]);
        if (!allowed) continue;
      }
      granted.push({ lane: lane.name, unitId: record.unit.id, serviceClass });
      free -= 1;
      capacity.set(key, used + (granted.filter((entry) => (group ? group.lanes : [lane.name]).includes(entry.lane)).length));
    }
  }
  return granted;
}
