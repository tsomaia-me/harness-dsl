import type { JournalDef, RecallCandidate } from '../dsl/memory.js';
import type { RecallCtx } from '../dsl/policies.js';
import type { MemoryItem } from '../kernel/backends.js';
import type { StoredFacetValue } from '../kernel/lifecycle.js';

/** How many items the kernel's own recall hands a seat when the journal names no policy. */
export const RECALL_LIMIT = 8;

export interface RecallScope {
  readonly kind: string;
  readonly role: string;
  readonly resources: readonly string[];
  readonly facets: readonly StoredFacetValue[];
}

/**
 * Scope axes the item constrains and the invocation matches (design §5.11). An empty axis on the
 * item is unconstrained and counts nothing; a constrained axis the invocation misses puts the item
 * out of scope.
 */
export function specificityOf(item: MemoryItem, scope: RecallScope): number | undefined {
  let matched = 0;
  const axes: readonly [readonly string[], readonly string[]][] = [
    [item.when.kinds, [scope.kind]],
    [item.when.roles, [scope.role]],
    [item.when.resources, scope.resources],
    [item.when.facets.map((facet) => `${facet.facet}:${facet.value}`), scope.facets.map((facet) => `${facet.facet}:${facet.value}`)],
  ];
  for (const [constraint, present] of axes) {
    if (constraint.length === 0) continue;
    if (!constraint.some((value) => present.includes(value))) return undefined;
    matched += 1;
  }
  return matched;
}

function successRatio(record: MemoryItem['trackRecord']): number {
  return record.used === 0 ? 0 : record.succeeded / record.used;
}

/** The kernel's recall: by specificity, then track record, newest first, cut at the limit. */
export function defaultRecall(ctx: RecallCtx): readonly MemoryItem[] {
  return [...ctx.candidates]
    .sort(
      (p, q) =>
        q.specificity - p.specificity ||
        successRatio(q.trackRecord) - successRatio(p.trackRecord) ||
        q.item.createdAt.getTime() - p.item.createdAt.getTime(),
    )
    .slice(0, ctx.limit)
    .map((candidate) => candidate.item);
}

export interface Recalled {
  readonly items: readonly MemoryItem[];
  readonly decisions: readonly { readonly policy: string; readonly ids: readonly string[] }[];
}

/** Recall for one invocation: the journals the role reads, each chosen by its own policy. */
export async function recall(journals: readonly JournalDef[], scope: RecallScope): Promise<Recalled> {
  const items: MemoryItem[] = [];
  const decisions: { policy: string; ids: readonly string[] }[] = [];
  for (const journal of journals) {
    if (!journal.memoryStore || !journal.readers.some((reader) => reader.name === scope.role)) continue;
    const candidates: RecallCandidate[] = [];
    for (const item of await journal.memoryStore.list({ journal: journal.name, status: ['active'] })) {
      if (item.status !== 'active') continue;
      const specificity = specificityOf(item, scope);
      if (specificity === undefined) continue;
      candidates.push({ item, specificity, trackRecord: item.trackRecord, similarity: null });
    }
    const ctx: RecallCtx = { candidates, limit: RECALL_LIMIT };
    const chosen = journal.recallPolicy ? journal.recallPolicy.decide(ctx) : defaultRecall(ctx);
    if (journal.recallPolicy) decisions.push({ policy: journal.recallPolicy.name, ids: chosen.map((item) => item.id) });
    items.push(...chosen);
  }
  return { items, decisions };
}
