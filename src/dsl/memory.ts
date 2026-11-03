import type { MemoryItem, MemoryStore } from '../kernel/backends.js';
import type { Named } from '../kernel/refs.js';
import type { RoleRef } from '../kernel/lifecycle.js';
import type { RecallPolicyDef } from './policies.js';

export type Trust = 'experience' | 'taste';

export interface MemoryKindDef extends Named {
  readonly entity: 'memory';
  readonly trust: Trust;
}

export function memory(name: string, trust: Trust): MemoryKindDef {
  return { entity: 'memory', name, trust };
}

export interface MemoryDraft {
  readonly text: string;
  readonly when?: {
    readonly kinds?: readonly Named[];
    readonly roles?: readonly RoleRef[];
    readonly resources?: readonly Named[];
    readonly facets?: readonly { readonly facet: Named; readonly value: string }[];
  };
  readonly status?: 'candidate' | 'active';
}

export interface RecallCandidate {
  readonly item: MemoryItem;
  readonly specificity: number;
  readonly trackRecord: { readonly used: number; readonly succeeded: number };
  readonly similarity: number | null;
}

export class JournalDef implements Named {
  public readonly entity = 'journal' as const;
  public readonly name: string;
  public readonly memoryKind: MemoryKindDef;
  public readonly memoryStore: MemoryStore | undefined;
  public readonly recallPolicy: RecallPolicyDef | undefined;
  public readonly readers: readonly RoleRef[];
  public readonly recorders: readonly RoleRef[];

  public constructor(
    name: string,
    memoryKind: MemoryKindDef,
    fields: {
      readonly memoryStore?: MemoryStore;
      readonly recallPolicy?: RecallPolicyDef;
      readonly readers?: readonly RoleRef[];
      readonly recorders?: readonly RoleRef[];
    } = {},
  ) {
    this.name = name;
    this.memoryKind = memoryKind;
    this.memoryStore = fields.memoryStore;
    this.recallPolicy = fields.recallPolicy;
    this.readers = fields.readers ?? [];
    this.recorders = fields.recorders ?? [];
  }

  private with(patch: {
    readonly memoryStore?: MemoryStore;
    readonly recallPolicy?: RecallPolicyDef;
    readonly readers?: readonly RoleRef[];
    readonly recorders?: readonly RoleRef[];
  }): JournalDef {
    return new JournalDef(this.name, this.memoryKind, {
      memoryStore: this.memoryStore,
      recallPolicy: this.recallPolicy,
      readers: this.readers,
      recorders: this.recorders,
      ...patch,
    });
  }

  public store(memoryStore: MemoryStore): JournalDef {
    return this.with({ memoryStore });
  }

  public recall(recallPolicy: RecallPolicyDef): JournalDef {
    return this.with({ recallPolicy });
  }

  public readBy(...roles: readonly RoleRef[]): JournalDef {
    return this.with({ readers: [...this.readers, ...roles] });
  }

  public recordedBy(...roles: readonly RoleRef[]): JournalDef {
    return this.with({ recorders: [...this.recorders, ...roles] });
  }
}

export function journal(name: string, memoryKind: MemoryKindDef): JournalDef {
  return new JournalDef(name, memoryKind);
}
