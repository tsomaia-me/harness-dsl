import type {
  Client,
  Grant,
  Ledger,
  MemoryStore,
  Model,
  Observer,
  QuotaPartition,
  RunnerBackend,
  Store,
  Supplier,
  WorkspaceBackend,
} from '../../../src/kernel/index.js';
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
