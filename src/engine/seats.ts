import type { FlowNode } from '../dsl/flows.js';
import type { HarnessDef } from '../dsl/harness.js';
import type { JobDef } from '../dsl/jobs.js';
import type { ModelPolicyDef } from '../dsl/policies.js';
import type { SeatDef } from '../dsl/seats.js';
import type { Model } from '../kernel/backends.js';
import type { Account, QuotaPartition } from '../kernel/quota.js';

export type AnySeat = SeatDef<unknown, unknown, string, boolean>;

export interface SeatStep {
  readonly seat: AnySeat;
  readonly path: string;
  readonly guarded: boolean;
}

function visit(nodes: readonly FlowNode[], path: string, found: SeatStep[]): void {
  for (const node of nodes) {
    const here = `${path}/${node.name}`;
    if (node.type === 'step') {
      const exec = node.exec;
      if (exec.entity === 'seat') found.push({ seat: exec as AnySeat, path: here, guarded: node.options.guard !== undefined });
      if (exec.entity === 'job') {
        const batchOf = (exec as JobDef<unknown, unknown>).batchOf;
        if (batchOf) found.push({ seat: batchOf, path: here, guarded: false });
      }
    }
    if (node.type === 'parallel') {
      for (const [name, branch] of Object.entries(node.branches)) {
        const exec = 'exec' in branch ? branch.exec : branch;
        if (exec.entity === 'seat') found.push({ seat: exec as AnySeat, path: `${here}/${name}`, guarded: false });
      }
    }
    if (node.type === 'when' || node.type === 'loop') visit(node.nodes, here, found);
  }
}

/** Every seat step of the harness, in registration order: lanes, then the flow tree depth first. */
export function seatSteps(harness: HarnessDef): readonly SeatStep[] {
  const found: SeatStep[] = [];
  for (const lane of harness.laneList) {
    const flow = (lane as { readonly handlerDef?: { readonly flow: { readonly nodes: readonly FlowNode[] } } }).handlerDef?.flow;
    if (flow) visit(flow.nodes, '', found);
  }
  return found;
}

/** The distinct seats, first appearance first; this order is the precedence of a `distinct` policy. */
export function seatsOf(harness: HarnessDef): readonly AnySeat[] {
  const seen = new Set<AnySeat>();
  for (const step of seatSteps(harness)) seen.add(step.seat);
  return [...seen];
}

export function modelsOf(seat: AnySeat): readonly Model[] {
  const choice = seat.modelChoice;
  if (!choice) return [];
  return choice.entity === 'model' ? [choice] : (choice as ModelPolicyDef).candidates;
}

export function accountsOf(seat: AnySeat): readonly Account[] {
  const pool = seat.poolDef;
  if (!pool) return [];
  return pool.fallbackAccount ? [...pool.accountList, pool.fallbackAccount] : pool.accountList;
}

/** The quota partitions the harness takes part in: those of every account a seat or a share names. */
export function partitionsOf(harness: HarnessDef): readonly QuotaPartition[] {
  const partitions = new Set<QuotaPartition>();
  for (const seat of seatsOf(harness)) for (const account of accountsOf(seat)) partitions.add(account.quota);
  for (const share of harness.shares) partitions.add(share.account.quota);
  return [...partitions];
}
