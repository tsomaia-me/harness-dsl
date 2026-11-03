import type { SequencedEvent, UnitRecord } from './events.js';
import type { HaltRef } from './lifecycle.js';
import type { Metrics } from './metrics.js';
import type { Account, ObservedWindow } from './quota.js';
import type { Json, JsonObject, Named, PortRef, Resolver } from './refs.js';

/** A guarded seat's tool event, as the driver's protocol parses it from the agent's hook payload. */
export interface GuardEvent {
  readonly phase: 'pre-tool' | 'stop';
  readonly filePaths: readonly string[];
  readonly raw: JsonObject;
}

export interface GuardDecision {
  readonly allow: boolean;
  readonly reason?: string;
}

export interface GuardProtocol {
  parse(payload: JsonObject): GuardEvent | null;
  formatDecision(event: GuardEvent, decision: GuardDecision): JsonObject;
}

export interface Store<M extends string = never> extends Named {
  readonly entity: 'store';
  readonly _statesMapTo?: M;
  readonly creates: boolean;
  create(kind: string, state: string, attributes: JsonObject, resolver: Resolver): Promise<{ readonly key: string }>;
  load(key: string, resolver: Resolver): Promise<{ readonly state: string; readonly attributes: JsonObject } | undefined>;
  save(key: string, attributes: JsonObject, resolver: Resolver): Promise<void>;
  transition(key: string, state: string, resolver: Resolver): Promise<void>;
}

export interface StoredScope {
  readonly kinds: readonly string[];
  readonly roles: readonly string[];
  readonly resources: readonly string[];
  readonly facets: readonly { readonly facet: string; readonly value: string }[];
}

export interface MemoryItem {
  readonly id: string;
  readonly memoryKind: string;
  readonly journal: string;
  readonly createdAt: Date;
  readonly status: 'candidate' | 'active' | 'retired';
  readonly when: StoredScope;
  readonly text: string;
  readonly mergedInto?: string;
  readonly trackRecord: { readonly used: number; readonly succeeded: number };
}

export interface MemoryFilter {
  readonly journal: string;
  readonly status?: readonly MemoryItem['status'][];
}

export interface MemoryStore extends Named {
  readonly entity: 'memoryStore';
  put(item: MemoryItem): Promise<void>;
  list(filter: MemoryFilter): Promise<readonly MemoryItem[]>;
  update(
    id: string,
    change: {
      readonly status?: MemoryItem['status'];
      readonly text?: string;
      readonly mergedInto?: string;
      readonly trackRecord?: MemoryItem['trackRecord'];
    },
  ): Promise<void>;
  similar?(filter: MemoryFilter, text: string, limit: number): Promise<readonly { readonly item: MemoryItem; readonly score: number }[]>;
}

export interface SupplySink<E> {
  emit(event: E, externalId: string): Promise<void>;
}

export interface Supplier<E> extends Named {
  readonly entity: 'supplier';
  start(sink: SupplySink<E>, resolver: Resolver): Promise<{ stop(): Promise<void> }>;
}

export interface Model<D extends string = string> extends Named {
  readonly entity: 'model';
  readonly id: string;
  readonly driver: D;
  readonly batch: boolean;
}

export interface BatchModel<D extends string = string> extends Model<D> {
  readonly batch: true;
}

export interface ModelRequest {
  readonly seat: string;
  readonly model: string;
  readonly account: Account;
  readonly role: { readonly name: string; readonly intents: readonly string[]; readonly prompt: string };
  readonly input: Json;
  readonly memory: readonly MemoryItem[];
  readonly halts: readonly { readonly name: string; readonly decisionSchema: Json }[];
  readonly outputSchema: Json;
  readonly workspacePath?: string;
  readonly idempotencyKey: string;
  /** The decision on a halt this call raised; `sessionId` when the driver kept a session to resume. */
  readonly resume?: { readonly sessionId?: string; readonly halt: string; readonly decision: Json };
  /** Aborted when the attempt is cancelled; a driver stops the agent and may throw. */
  readonly cancel?: AbortSignal;
  /** Set on a guarded step: the agent's hooks post to `endpoint` with `?invocation=<invocation>`. */
  readonly guard?: { readonly endpoint: string; readonly invocation: string; readonly leases: boolean; readonly stop: boolean };
}

export interface ModelResponse {
  readonly output: Json;
  readonly costUsd: number | null;
  readonly tokens: number;
  readonly sessionId?: string;
  readonly halt?: { readonly halt: string; readonly ask: string };
  readonly recorded?: readonly { readonly journal: string; readonly text: string; readonly when: StoredScope }[];
  readonly cooldownUntil?: Date;
  readonly windows?: readonly ObservedWindow[];
  /** What the call would have cost at list price when `costUsd` is a prepaid plan's zero. */
  readonly equivalentUsd?: number;
}

export type SessionStatus =
  | { readonly status: 'finished'; readonly response: ModelResponse }
  | { readonly status: 'running' }
  | { readonly status: 'lost' };

export interface ModelDriver<D extends string = string> extends Named {
  readonly driver: D;
  readonly hooks: boolean;
  readonly guardProtocol?: GuardProtocol;
  serves(account: Account): boolean;
  invoke(request: ModelRequest, resolver: Resolver): Promise<ModelResponse>;
  session?(idempotencyKey: string, resolver: Resolver): Promise<SessionStatus>;
  submitBatch?(requests: readonly ModelRequest[], resolver: Resolver): Promise<{ readonly jobId: string }>;
  collectBatch?(jobId: string, resolver: Resolver): Promise<readonly ModelResponse[] | undefined>;
}

export interface Embedder extends Named {
  readonly entity: 'embedder';
  readonly id: string;
  embed(texts: readonly string[], resolver: Resolver): Promise<readonly (readonly number[])[]>;
}

export interface RunnerBackend {
  exec(
    command: { readonly argv: readonly string[]; readonly env: Readonly<Record<string, string>>; readonly cwd?: string },
    cancel: AbortSignal,
    resolver: Resolver,
  ): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string; readonly durationMs: number }>;
}

export interface WorkspaceBackend {
  prepare(attemptId: string): Promise<{ readonly path: string }>;
  release(attemptId: string): Promise<void>;
}

export interface Workspace extends Named {
  readonly entity: 'workspace';
  readonly backend: WorkspaceBackend;
  readonly areas: Readonly<Record<string, readonly string[]>>;
}

export interface Grant {
  readonly entity: 'grant';
  readonly operation: string;
  readonly halts?: readonly HaltRef[];
}

export interface ControlApi {
  readonly harness: string;
  operations(): readonly { readonly name: string; readonly inputSchema: Json }[];
  call(operation: string, input: Json, caller: string): Promise<Json>;
  subscribe(listener: (event: SequencedEvent) => void): () => void;
}

export interface ClientEndpoint {
  readonly transport: string;
  readonly port?: PortRef;
}

export interface Client extends Named {
  readonly entity: 'client';
  readonly grants: readonly Grant[];
  readonly endpoint: ClientEndpoint;
  serve(api: ControlApi, resolver: Resolver): Promise<{ stop(): Promise<void> }>;
}

export interface Observer extends Named {
  readonly entity: 'observer';
  observe(
    event: SequencedEvent,
    query: { unit(id: string): Promise<UnitRecord | undefined>; readonly metrics: Metrics; readonly resolver: Resolver },
  ): Promise<void>;
}
