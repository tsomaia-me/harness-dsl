import type { FlowDef } from '../dsl/flows.js';
import type { Ledger, LedgerEvent, LoopSpan, UnitRecord } from '../kernel/index.js';
import type { Json } from '../kernel/refs.js';
import { topLevelIndex } from './address.js';

export interface LoopMemo {
  readonly iteration: number;
  readonly span: LoopSpan;
  readonly carry?: Json;
}

export interface Memo {
  readonly outputs: Map<string, Json>;
  readonly decisions: Map<string, Json>;
  readonly reads: Map<string, Json>;
  readonly loops: Map<string, LoopMemo>;
  readonly jobs: Map<string, { readonly jobId: string; readonly collected: boolean }>;
  readonly invocations: Map<string, { readonly started: boolean; readonly sessionId?: string; readonly ended: boolean }>;
  readonly blocked?: { readonly step: string; readonly on: string; readonly halt?: string };
  readonly interrupted: boolean;
  readonly lastAt: Date;
  readonly rewinds: number;
}

function supersede(flow: FlowDef<unknown, unknown, unknown, string, string>, target: string, maps: readonly Map<string, unknown>[]): void {
  const cut = topLevelIndex(flow, target);
  for (const map of maps) {
    for (const addr of [...map.keys()]) {
      if (topLevelIndex(flow, addr) >= cut) map.delete(addr);
    }
  }
}

export async function buildMemo(
  ledger: Ledger,
  flow: FlowDef<unknown, unknown, unknown, string, string>,
  record: UnitRecord,
  attemptId: string,
): Promise<Memo> {
  const outputs = new Map<string, Json>();
  const decisions = new Map<string, Json>();
  const reads = new Map<string, Json>();
  const loops = new Map<string, LoopMemo>();
  const jobs = new Map<string, { readonly jobId: string; readonly collected: boolean }>();
  const invocations = new Map<string, { readonly started: boolean; readonly sessionId?: string; readonly ended: boolean }>();
  let blocked: Memo['blocked'];
  let interrupted = false;
  let lastAt = record.unit.attempt?.startedAt ?? record.unit.createdAt;
  let rewinds = 0;

  for (const [loop, memo] of Object.entries(record.loops)) {
    if (memo.span === 'unit') loops.set(loop, memo);
  }

  for await (const { event } of ledger.read({ attemptId })) {
    lastAt = event.at;
    apply(event);
  }

  function apply(event: LedgerEvent): void {
    switch (event.type) {
      case 'stepStarted':
        invocations.set(event.step, { started: true, ended: false });
        return;
      case 'stepEnded':
        if (event.ok) outputs.set(event.step, event.output ?? null);
        invocations.set(event.step, { ...(invocations.get(event.step) ?? { started: true }), ended: true });
        return;
      case 'invocation':
        if (event.sessionId) invocations.set(event.step, { started: true, sessionId: event.sessionId, ended: event.ok });
        return;
      case 'decisionRecorded':
        decisions.set(event.step, event.decision);
        blocked = undefined;
        return;
      case 'metricRead':
        reads.set(event.step, { value: event.read.value, samples: event.read.samples });
        return;
      case 'loopIteration':
        loops.set(event.loop, { iteration: event.iteration, span: event.span, ...(event.carry !== undefined ? { carry: event.carry } : {}) });
        return;
      case 'jobSubmitted':
        jobs.set(event.step, { jobId: event.jobId, collected: false });
        return;
      case 'jobCollected':
        jobs.set(event.step, { jobId: event.jobId, collected: true });
        return;
      case 'attemptBlocked':
        blocked = { step: event.step, on: event.on, ...(event.halt ? { halt: event.halt } : {}) };
        return;
      case 'attemptResumed':
        blocked = undefined;
        return;
      case 'attemptInterrupted':
        interrupted = true;
        return;
      case 'attemptRewound':
        rewinds += 1;
        supersede(flow, event.to, [outputs, decisions, reads, jobs, invocations]);
        blocked = undefined;
        return;
      default:
        return;
    }
  }

  return { outputs, decisions, reads, loops, jobs, invocations, ...(blocked ? { blocked } : {}), interrupted, lastAt, rewinds };
}
