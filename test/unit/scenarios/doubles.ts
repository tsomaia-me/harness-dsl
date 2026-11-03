import type { Client, Grant, Ledger, LedgerEvent, MemoryItem, MemoryStore, Model, ModelDriver, ModelRequest, ModelResponse, Observer, QuotaEvent, QuotaPartition, RunnerBackend, Store, Supplier, WorkspaceBackend } from '../../../src/kernel/index.js';
import type { Account } from '../../../src/kernel/quota.js';
import { defineRunner, defineWorkspace, type RunnerDef, type WorkspaceDef } from '../../../src/dsl/index.js';

function unused(what: string): never {
  throw new Error(`${what} is a test double and must not be called`);
}

export function fakeLedger(): Ledger {
  return {
    append: async () => unused('ledger.append'),
    read: async function* () {},
    unit: async () => undefined,
    units: async () => [],
    dueTimers: async () => [],
    takeLease: async () => unused('ledger.takeLease'),
    claimWriter: async (holder) => ({ acquired: true, holder, expiresAt: new Date(0) }),
    releaseWriter: async () => undefined,
    close: () => undefined,
  };
}

export function fakeQuota(name: string): QuotaPartition {
  return { name, join: async () => ({ accepted: true }), append: async () => undefined, read: async function* () {}, close: () => undefined };
}

/** A partition that keeps what the engine appends, so a test can read usage back. */
export function recordingQuota(name: string): QuotaPartition & { readonly events: QuotaEvent[] } {
  const events: QuotaEvent[] = [];
  return {
    name,
    events,
    join: async () => ({ accepted: true }),
    append: async (batch) => {
      events.push(...batch);
    },
    read: async function* (query) {
      for (const event of events) if (query.accounts.includes(event.account) && event.at >= query.since) yield event;
    },
    close: () => undefined,
  };
}

export function fakeAccount<D extends string>(name: string, driver: D, quota: QuotaPartition): Account<D> {
  return { entity: 'account', name, driver, credential: { ref: 'env', name: `${name.toUpperCase()}_TOKEN` }, quota };
}

export function fakeModel<D extends string>(name: string, driver: D, id: string): Model<D> {
  return { entity: 'model', name, id, driver, batch: false };
}

export function fakeSupplier<E>(name: string): Supplier<E> {
  return { entity: 'supplier', name, start: async () => ({ stop: async () => undefined }) };
}

export function fakeStore<M extends string>(name: string, statuses: readonly M[]): Store<M> {
  void statuses;
  return {
    entity: 'store',
    name,
    creates: true,
    create: async () => unused('store.create'),
    load: async () => undefined,
    save: async () => undefined,
    transition: async () => undefined,
  };
}

export function fakeMemoryStore(name: string): MemoryStore {
  return { entity: 'memoryStore', name, put: async () => undefined, list: async () => [], update: async () => undefined };
}

export function fakeClient(name: string, grants: readonly Grant[]): Client {
  return { entity: 'client', name, grants, endpoint: { transport: 'test' }, serve: async () => ({ stop: async () => undefined }) };
}

export function fakeObserver(name: string): Observer {
  return { entity: 'observer', name, observe: async () => undefined };
}

const backend: RunnerBackend = { exec: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 0 }) };
const workspaceBackend: WorkspaceBackend = { prepare: async () => ({ path: '/tmp/double' }), release: async () => undefined };

export function fakeRunner(name: string): RunnerDef {
  return defineRunner(name, backend);
}

export function fakeWorkspace(name: string): WorkspaceDef {
  return defineWorkspace(name, workspaceBackend);
}

export class ScriptedDriver implements ModelDriver<'test'> {
  public readonly name = 'test-driver';
  public readonly driver = 'test' as const;
  public readonly hooks = true;
  public readonly requests: ModelRequest[] = [];
  public constructor(private readonly respond: (request: ModelRequest) => ModelResponse) {}
  public serves() {
    return true;
  }
  public async invoke(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return this.respond(request);
  }
}

export class RecordingMemory implements MemoryStore {
  public readonly entity = 'memoryStore' as const;
  public readonly items: MemoryItem[] = [];
  public constructor(public readonly name: string) {}
  public async put(item: MemoryItem) {
    this.items.push(item);
  }
  public async list(filter: { readonly journal: string; readonly status?: readonly MemoryItem['status'][] }) {
    return this.items.filter((item) => item.journal === filter.journal && (!filter.status || filter.status.includes(item.status)));
  }
  public async update(id: string, change: Parameters<MemoryStore['update']>[1]) {
    const at = this.items.findIndex((item) => item.id === id);
    if (at === -1) return;
    this.items[at] = { ...this.items[at]!, ...change };
  }
}

export async function eventsOf(ledger: Ledger, type?: LedgerEvent['type']): Promise<LedgerEvent[]> {
  const out: LedgerEvent[] = [];
  for await (const { event } of ledger.read(type ? { types: [type] } : {})) out.push(event);
  return out;
}
