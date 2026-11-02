import type { FlowDef } from '../dsl/flows.js';
import type { Ledger, LedgerEvent, LoopSpan, UnitRecord } from '../kernel/index.js';
import type { Json } from '../kernel/refs.js';
import { topLevelIndex } from './address.js';

export interface LoopMemo {
  readonly iteration: number;
  readonly span: LoopSpan;
  readonly carry?: Json;
}

export interface InvocationMemo {
  readonly started: boolean;
  readonly ended: boolean;
  /** How many invocations the step has recorded, refused ones included. */
  readonly number: number;
  readonly sessionId?: string;
  readonly account?: string;
  readonly model?: string;
}

/** What an attempt's ledger says about each address, so a walk returns recorded results at no cost (design §5.4). */
export interface Memo {
  readonly outputs: Map<string, Json>;
  readonly decisions: Map<string, Json>;
  readonly decided: Map<string, { readonly halt: string; readonly decision: Json }>;
  readonly reads: Map<string, Json>;
  readonly loops: Map<string, LoopMemo>;
  readonly jobs: Map<string, { readonly jobId: string; readonly collected: boolean }>;
  readonly invocations: Map<string, InvocationMemo>;
  /** When each address was first visited: `ctx.now` on replay. */
  readonly visited: Map<string, Date>;
  /** Addresses the attempt blocked at and has not resumed from: the step yielded, it did not crash. */
  readonly blockedAt: Set<string>;
  /** Addresses the attempt resumed at and has not started again since: the step is being resumed, not recovered. */
  readonly resumedAt: Set<string>;
  /** Addresses the attempt was interrupted at and has not finished since. */
  readonly interruptedAt: Set<string>;
  readonly notAsked: Set<string>;
  readonly failures: Map<string, number>;
  readonly blocked?: { readonly step: string; readonly on: string; readonly halt?: string };
  readonly interrupted: boolean;
  readonly lastAt: Date;
  readonly rewinds: number;
  readonly costUsd: number;
  readonly equivalentUsd: number;
}

/** The addresses at or after a rewind target, which the rewind supersedes. */
export function supersededBy(flow: FlowDef<unknown, unknown, unknown, string, string>, target: string, addresses: Iterable<string>): string[] {
  const cut = topLevelIndex(flow, target);
  return [...new Set([...addresses].filter((addr) => topLevelIndex(flow, addr) >= cut))];
}

export async function buildMemo(
  ledger: Ledger,
  flow: FlowDef<unknown, unknown, unknown, string, string>,
  record: UnitRecord,
  attemptId: string,
): Promise<Memo> {
  const outputs = new Map<string, Json>();
  const decisions = new Map<string, Json>();
  const decided = new Map<string, { readonly halt: string; readonly decision: Json }>();
  const reads = new Map<string, Json>();
  const loops = new Map<string, LoopMemo>();
  const jobs = new Map<string, { readonly jobId: string; readonly collected: boolean }>();
  const invocations = new Map<string, InvocationMemo>();
  const visited = new Map<string, Date>();
  const blockedAt = new Set<string>();
  const resumedAt = new Set<string>();
  const interruptedAt = new Set<string>();
  const notAsked = new Set<string>();
  const failures = new Map<string, number>();
  let blocked: Memo['blocked'];
  let interrupted = false;
  let lastAt = record.unit.attempt?.startedAt ?? record.unit.createdAt;
  let rewinds = 0;
  let costUsd = 0;
  let equivalentUsd = 0;

  for (const [loop, memo] of Object.entries(record.loops)) {
    if (memo.span === 'unit') loops.set(loop, memo);
  }

  const supersede = (target: string): void => {
    const cut = topLevelIndex(flow, target);
    for (const map of [outputs, decisions, decided, reads, jobs, invocations, visited, failures]) {
      for (const addr of [...map.keys()]) if (topLevelIndex(flow, addr) >= cut) map.delete(addr);
    }
    for (const set of [blockedAt, resumedAt, interruptedAt, notAsked]) for (const addr of [...set]) if (topLevelIndex(flow, addr) >= cut) set.delete(addr);
  };

  for await (const { event } of ledger.read({ attemptId })) {
    lastAt = event.at;
    switch (event.type) {
      case 'stepStarted':
        invocations.set(event.step, { ...(invocations.get(event.step) ?? { number: 0 }), started: true, ended: false });
        if (!visited.has(event.step)) visited.set(event.step, event.at);
        resumedAt.delete(event.step);
        break;
      case 'stepEnded':
        if (event.ok) outputs.set(event.step, event.output ?? null);
        else failures.set(event.step, (failures.get(event.step) ?? 0) + 1);
        invocations.set(event.step, { ...(invocations.get(event.step) ?? { started: true, number: 0 }), ended: true });
        interruptedAt.delete(event.step);
        resumedAt.delete(event.step);
        break;
      case 'invocation': {
        const previous = invocations.get(event.step) ?? { started: true, ended: false, number: 0 };
        invocations.set(event.step, {
          ...previous,
          ended: previous.ended || event.ok,
          number: Math.max(previous.number, event.number),
          ...(event.sessionId ? { sessionId: event.sessionId } : {}),
          ...(event.account ? { account: event.account } : {}),
          ...(event.model ? { model: event.model } : {}),
        });
        if (event.ok) {
          interruptedAt.delete(event.step);
          costUsd += event.costUsd;
          equivalentUsd += event.equivalentUsd ?? event.costUsd;
        }
        break;
      }
      case 'decisionRecorded':
        decisions.set(event.step, event.decision);
        decided.set(event.step, { halt: event.halt, decision: event.decision });
        blocked = undefined;
        break;
      case 'haltNotAsked':
        notAsked.add(event.step);
        break;
      case 'metricRead':
        reads.set(event.step, { value: event.read.value, samples: event.read.samples });
        break;
      case 'loopIteration':
        loops.set(event.loop, { iteration: event.iteration, span: event.span, ...(event.carry !== undefined ? { carry: event.carry } : {}) });
        break;
      case 'jobSubmitted':
        jobs.set(event.step, { jobId: event.jobId, collected: false });
        break;
      case 'jobCollected':
        jobs.set(event.step, { jobId: event.jobId, collected: true });
        break;
      case 'attemptBlocked':
        blocked = { step: event.step, on: event.on, ...(event.halt ? { halt: event.halt } : {}) };
        blockedAt.add(event.step);
        resumedAt.delete(event.step);
        break;
      case 'attemptResumed':
        blocked = undefined;
        blockedAt.delete(event.step);
        resumedAt.add(event.step);
        break;
      case 'attemptInterrupted':
        interrupted = true;
        interruptedAt.add(event.step);
        break;
      case 'attemptRewound':
        rewinds += 1;
        supersede(event.to);
        blocked = undefined;
        break;
      default:
        break;
    }
  }

  return { outputs, decisions, decided, reads, loops, jobs, invocations, visited, blockedAt, resumedAt, interruptedAt, notAsked, failures, ...(blocked ? { blocked } : {}), interrupted, lastAt, rewinds, costUsd, equivalentUsd };
}
