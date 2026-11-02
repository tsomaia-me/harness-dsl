import type { HarnessDef } from '../dsl/harness.js';
import type { LaneDef } from '../dsl/lanes.js';
import type { Amount, AnyMetric, Sample } from '../dsl/metrics.js';
import type { Source } from '../dsl/sources.js';
import type {
  AttemptCounts,
  DecisionCounts,
  Dimensions,
  JobHours,
  LeaseWaits,
  Ledger,
  LedgerEvent,
  MetricQuery,
  MetricRead,
  MetricRef,
  Metrics,
  OutcomeCounts,
  PausedTime,
  Rate,
  State,
  StoredDimensions,
  Total,
  UnitRecord,
  Window,
  WorkScope,
} from '../kernel/index.js';
import { decisionEvent, inWindow, invocationEvent, stepEvent, stepName, transitionEvent, unitViewOf } from './events.js';

type AnyLane = LaneDef<unknown, State, unknown, string>;

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function matchesDimensions(sample: Sample | Amount, query: Dimensions): boolean {
  if (query.seat && sample.seat?.name !== query.seat.name) return false;
  if (query.model && sample.model?.name !== query.model.name) return false;
  if (query.resource && sample.resource?.name !== query.resource.name) return false;
  if (query.halt && sample.halt?.name !== query.halt.name) return false;
  for (const facet of query.facets ?? []) {
    if (!sample.facets?.some((candidate) => candidate.facet.name === facet.facet.name && candidate.value === facet.value)) return false;
  }
  return true;
}

export class LedgerMetrics implements Metrics {
  private events: LedgerEvent[] = [];
  private units = new Map<string, UnitRecord>();
  private lanesByUnit = new Map<string, string>();
  private loadedSeq = 0;
  private readonly lanes: ReadonlyMap<string, AnyLane>;
  private readonly metrics: ReadonlyMap<string, AnyMetric>;

  public constructor(
    private readonly ledger: Ledger,
    harness: HarnessDef,
    private readonly now: () => Date,
  ) {
    this.lanes = new Map(harness.laneList.map((lane) => [lane.name, lane as AnyLane]));
    this.metrics = new Map(harness.metricList.map((metric) => [metric.name, metric]));
  }

  public async refresh(): Promise<void> {
    for await (const { seq, event } of this.ledger.read({ afterSeq: this.loadedSeq })) {
      this.events.push(event);
      this.loadedSeq = seq;
      if (event.type === 'unitCreated') this.lanesByUnit.set(event.unitId, event.lane);
    }
    this.units = new Map((await this.ledger.units({})).map((record) => [record.unit.id, record]));
  }

  private laneOfUnit(unitId: string): AnyLane | undefined {
    const name = this.lanesByUnit.get(unitId);
    return name ? this.lanes.get(name) : undefined;
  }

  private laneOfAttempt(attemptId: string): { readonly lane: AnyLane; readonly unitId: string } | undefined {
    for (const event of this.events) {
      if (event.type === 'attemptStarted' && event.attemptId === attemptId) {
        const lane = this.laneOfUnit(event.unitId);
        return lane ? { lane, unitId: event.unitId } : undefined;
      }
    }
    return undefined;
  }

  private view(unitId: string) {
    const record = this.units.get(unitId);
    const lane = this.laneOfUnit(unitId);
    return record && lane ? unitViewOf(record, lane) : undefined;
  }

  private scoped(of: WorkScope, unitId: string): boolean {
    const lane = this.lanesByUnit.get(unitId);
    if (of.entity === 'lane') return lane === of.name;
    const record = this.units.get(unitId);
    return record?.unit.kind === of.name;
  }

  public outcomes<S extends State>(query: { readonly of: WorkScope<S>; readonly window?: Window }): OutcomeCounts<S> {
    const now = this.now();
    const counts = new Map<string, number>();
    let success = 0;
    let failure = 0;
    let neutral = 0;
    for (const event of this.events) {
      if (event.type !== 'transition' || event.position !== 'terminal' || !this.scoped(query.of, event.unitId) || !inWindow(event.at, now, query.window)) continue;
      counts.set(event.to, (counts.get(event.to) ?? 0) + 1);
      if (event.verdict === 'success') success += 1;
      else if (event.verdict === 'failure') failure += 1;
      else neutral += 1;
    }
    const terminal = success + failure + neutral;
    return { terminal, success, failure, neutral, successRate: terminal === 0 ? 0 : success / terminal, samples: terminal, count: (state) => counts.get(state.name) ?? 0 };
  }

  public attempts(query: { readonly of: WorkScope; readonly seat?: { readonly name: string }; readonly model?: { readonly name: string }; readonly window?: Window }): AttemptCounts {
    const now = this.now();
    const participants = new Map<string, { seats: Set<string>; models: Set<string> }>();
    for (const event of this.events) {
      if (event.type !== 'invocation') continue;
      const entry = participants.get(event.attemptId) ?? { seats: new Set(), models: new Set() };
      if (event.seat) entry.seats.add(event.seat);
      if (event.model) entry.models.add(event.model);
      participants.set(event.attemptId, entry);
    }
    let succeeded = 0;
    let failed = 0;
    let cancelled = 0;
    let retried = 0;
    for (const event of this.events) {
      if (event.type === 'retryScheduled' && this.scoped(query.of, event.unitId) && inWindow(event.at, now, query.window)) retried += 1;
      if (event.type !== 'attemptEnded' || !inWindow(event.at, now, query.window)) continue;
      const owner = this.laneOfAttempt(event.attemptId);
      if (!owner || !this.scoped(query.of, owner.unitId)) continue;
      const entry = participants.get(event.attemptId);
      if (query.seat && !entry?.seats.has(query.seat.name)) continue;
      if (query.model && !entry?.models.has(query.model.name)) continue;
      if (event.outcome === 'succeeded') succeeded += 1;
      else if (event.outcome === 'failed') failed += 1;
      else cancelled += 1;
    }
    const samples = succeeded + failed;
    return { succeeded, failed, cancelled, retried, successRate: samples === 0 ? 0 : succeeded / samples, samples };
  }

  public samplesOf(metric: AnyMetric, query?: MetricQuery): readonly (Sample | Amount)[] {
    const now = this.now();
    const out: (Sample | Amount)[] = [];
    for (const typed of this.typedEvents(metric.source)) {
      if (!inWindow(typed.at, now, query?.window)) continue;
      if (query?.of && typed.unitId !== undefined && !this.scoped(query.of, typed.unitId)) continue;
      for (const sample of (metric.extract as (event: unknown) => readonly (Sample | Amount)[])(typed.event)) {
        if (query && !matchesDimensions(sample, query)) continue;
        out.push(sample);
      }
    }
    return out;
  }

  public rate(metric: MetricRef<'rate'>, query?: MetricQuery): Rate {
    const def = this.metrics.get(metric.name);
    if (!def) return { rate: 0, hits: 0, samples: 0 };
    const samples = this.samplesOf(def, query).filter((sample): sample is Sample => 'hit' in sample);
    const hits = samples.filter((sample) => sample.hit).length;
    return { rate: samples.length === 0 ? 0 : hits / samples.length, hits, samples: samples.length };
  }

  public total(metric: MetricRef<'total'>, query?: MetricQuery): Total {
    const def = this.metrics.get(metric.name);
    if (!def) return { total: 0, samples: 0 };
    const amounts = this.samplesOf(def, query).filter((sample): sample is Amount => 'amount' in sample);
    return { total: amounts.reduce((sum, amount) => sum + amount.amount, 0), samples: amounts.length };
  }

  public paused(query: { readonly lane: { readonly name: string }; readonly window?: Window }): PausedTime {
    const now = this.now();
    let totalMs = 0;
    let count = 0;
    let pausedAt: Date | undefined;
    for (const event of this.events) {
      if (event.type === 'lanePaused' && event.lane === query.lane.name && pausedAt === undefined) {
        pausedAt = event.at;
        if (inWindow(event.at, now, query.window)) count += 1;
      }
      if (event.type === 'laneResumed' && event.lane === query.lane.name && pausedAt !== undefined) {
        totalMs += event.at.getTime() - pausedAt.getTime();
        pausedAt = undefined;
      }
    }
    if (pausedAt !== undefined) totalMs += now.getTime() - pausedAt.getTime();
    return { totalMs, count };
  }

  public decisions(query: { readonly halt: { readonly name: string }; readonly window?: Window }): DecisionCounts {
    const now = this.now();
    const blockedAt = new Map<string, Date>();
    const waits: number[] = [];
    const byResolver = new Map<string, { resolvedBy: DecisionCounts['byResolver'][number]['resolvedBy']; resolver: string; waits: number[] }>();
    for (const event of this.events) {
      if (event.type === 'attemptBlocked' && event.on === 'decision') blockedAt.set(`${event.attemptId}:${event.step}`, event.at);
      if (event.type !== 'decisionRecorded' || event.halt !== query.halt.name || !inWindow(event.at, now, query.window)) continue;
      const since = blockedAt.get(`${event.attemptId}:${event.step}`);
      const waited = since ? event.at.getTime() - since.getTime() : 0;
      waits.push(waited);
      const key = `${event.resolvedBy}:${event.by}`;
      const entry = byResolver.get(key) ?? { resolvedBy: event.resolvedBy, resolver: event.by, waits: [] };
      entry.waits.push(waited);
      byResolver.set(key, entry);
    }
    return {
      samples: waits.length,
      medianMs: median(waits),
      byResolver: [...byResolver.values()].map((entry) => ({ resolvedBy: entry.resolvedBy, resolver: entry.resolver, count: entry.waits.length, medianMs: median(entry.waits) })),
    };
  }

  public leases(query: { readonly resource: { readonly name: string }; readonly window?: Window }): LeaseWaits {
    const now = this.now();
    const waits = this.events.filter((event): event is Extract<LedgerEvent, { type: 'leaseTaken' }> => event.type === 'leaseTaken' && event.resource === query.resource.name && inWindow(event.at, now, query.window)).map((event) => event.waitedMs);
    return { samples: waits.length, medianWaitMs: median(waits), totalWaitMs: waits.reduce((sum, wait) => sum + wait, 0) };
  }

  public jobs(query: { readonly job: { readonly name: string }; readonly window?: Window }): JobHours {
    const now = this.now();
    const submitted = new Map<string, Date>();
    let hours = 0;
    let samples = 0;
    let inFlight = 0;
    for (const event of this.events) {
      if (event.type === 'jobSubmitted' && event.job === query.job.name) submitted.set(event.jobId, event.at);
      if (event.type === 'jobCollected' && event.job === query.job.name) {
        const start = submitted.get(event.jobId);
        if (start) {
          hours += this.overlapHours(start, event.at, now, query.window);
          samples += 1;
          submitted.delete(event.jobId);
        }
      }
    }
    for (const start of submitted.values()) {
      hours += this.overlapHours(start, now, now, query.window);
      inFlight += 1;
      samples += 1;
    }
    return { hoursInFlight: hours, inFlightNow: inFlight, samples };
  }

  private overlapHours(start: Date, end: Date, now: Date, window: Window | undefined): number {
    const windowStart = window && 'lastDays' in window ? now.getTime() - window.lastDays * 86_400_000 : window && 'lastHours' in window ? now.getTime() - window.lastHours * 3_600_000 : Number.NEGATIVE_INFINITY;
    const from = Math.max(start.getTime(), windowStart);
    const to = Math.min(end.getTime(), now.getTime());
    return to > from ? (to - from) / 3_600_000 : 0;
  }

  public read(metric: MetricRef, query?: MetricQuery): MetricRead {
    const value = metric.measure === 'rate' ? this.rate(metric as MetricRef<'rate'>, query) : this.total(metric as MetricRef<'total'>, query);
    const dimensions: StoredDimensions = {
      ...(query?.seat ? { seat: query.seat.name } : {}),
      ...(query?.model ? { model: query.model.name } : {}),
      ...(query?.halt ? { halt: query.halt.name } : {}),
      ...(query?.resource ? { resource: query.resource.name } : {}),
      ...(query?.facets ? { facets: query.facets.map((facet) => ({ facet: facet.facet.name, value: facet.value })) } : {}),
    };
    return { metric: metric.name, dimensions, value: 'rate' in value ? value.rate : value.total, samples: value.samples };
  }

  public *typedEvents(source: Source<unknown>): Iterable<{ readonly event: unknown; readonly at: Date; readonly unitId?: string; readonly seq: number }> {
    const spec = source.spec;
    const blockedAt = new Map<string, Date>();
    const modelsBySeat = new Map<string, string>();
    let seq = 0;
    for (const event of this.events) {
      seq += 1;
      if (event.type === 'invocation' && event.seat && event.model) modelsBySeat.set(event.seat, event.model);
      if (event.type === 'attemptBlocked' && event.on === 'decision') blockedAt.set(`${event.attemptId}:${event.step}`, event.at);
      switch (spec.on) {
        case 'transition': {
          if (event.type !== 'transition') continue;
          const lane = this.laneOfUnit(event.unitId);
          if (!lane || lane.name !== spec.lane.name) continue;
          if (spec.to && !spec.to.some((state) => state.name === event.to)) continue;
          const view = this.view(event.unitId);
          if (!view) continue;
          const typed = transitionEvent(lane, view, event);
          if (spec.if && !spec.if(typed)) continue;
          yield { event: typed, at: event.at, unitId: event.unitId, seq };
          continue;
        }
        case 'step': {
          if (event.type !== 'stepEnded' || stepName(event.step) !== spec.step) continue;
          const owner = this.laneOfAttempt(event.attemptId);
          if (!owner || owner.lane.name !== spec.lane.name) continue;
          const view = this.view(owner.unitId);
          if (!view) continue;
          const typed = stepEvent(view, event);
          if (spec.if && !spec.if(typed)) continue;
          yield { event: typed, at: event.at, unitId: owner.unitId, seq };
          continue;
        }
        case 'decision': {
          if (event.type !== 'decisionRecorded' || event.halt !== spec.halt.name) continue;
          const owner = this.laneOfAttempt(event.attemptId);
          if (!owner || owner.lane.kind.name !== spec.kind.name) continue;
          const view = this.view(owner.unitId);
          if (!view) continue;
          const since = blockedAt.get(`${event.attemptId}:${event.step}`);
          yield { event: decisionEvent(view, event, since ? event.at.getTime() - since.getTime() : 0, modelsBySeat), at: event.at, unitId: owner.unitId, seq };
          continue;
        }
        case 'invocation': {
          if (event.type !== 'invocation') continue;
          const owner = this.laneOfAttempt(event.attemptId);
          if (!owner || !spec.lanes.some((lane) => lane.name === owner.lane.name)) continue;
          yield { event: invocationEvent(event), at: event.at, unitId: owner.unitId, seq };
          continue;
        }
        default:
          continue;
      }
    }
  }
}

export function recordingMetrics(metrics: Metrics): { readonly metrics: Metrics; readonly reads: MetricRead[] } {
  const reads: MetricRead[] = [];
  const dims = (query?: Dimensions): StoredDimensions => ({
    ...(query?.seat ? { seat: query.seat.name } : {}),
    ...(query?.model ? { model: query.model.name } : {}),
    ...(query?.halt ? { halt: query.halt.name } : {}),
    ...(query?.resource ? { resource: query.resource.name } : {}),
    ...(query?.facets ? { facets: query.facets.map((facet) => ({ facet: facet.facet.name, value: facet.value })) } : {}),
  });
  const recording: Metrics = {
    outcomes: (query) => {
      const value = metrics.outcomes(query);
      reads.push({ metric: `outcomes:${query.of.name}`, dimensions: {}, value: value.successRate, samples: value.samples });
      return value;
    },
    attempts: (query) => {
      const value = metrics.attempts(query);
      reads.push({ metric: `attempts:${query.of.name}`, dimensions: dims(query), value: value.successRate, samples: value.samples });
      return value;
    },
    rate: (metric, query) => {
      const value = metrics.rate(metric, query);
      reads.push({ metric: metric.name, dimensions: dims(query), value: value.rate, samples: value.samples });
      return value;
    },
    total: (metric, query) => {
      const value = metrics.total(metric, query);
      reads.push({ metric: metric.name, dimensions: dims(query), value: value.total, samples: value.samples });
      return value;
    },
    paused: (query) => {
      const value = metrics.paused(query);
      reads.push({ metric: `paused:${query.lane.name}`, dimensions: { lane: query.lane.name }, value: value.totalMs, samples: value.count });
      return value;
    },
    decisions: (query) => {
      const value = metrics.decisions(query);
      reads.push({ metric: `decisions:${query.halt.name}`, dimensions: { halt: query.halt.name }, value: value.medianMs, samples: value.samples });
      return value;
    },
    leases: (query) => {
      const value = metrics.leases(query);
      reads.push({ metric: `leases:${query.resource.name}`, dimensions: { resource: query.resource.name }, value: value.medianWaitMs, samples: value.samples });
      return value;
    },
    jobs: (query) => {
      const value = metrics.jobs(query);
      reads.push({ metric: `jobs:${query.job.name}`, dimensions: {}, value: value.hoursInFlight, samples: value.samples });
      return value;
    },
  };
  return { metrics: recording, reads };
}
