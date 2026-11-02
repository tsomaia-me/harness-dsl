import { z } from 'zod';
import type { OperationDef } from '../dsl/clients.js';
import type { Executable } from '../dsl/executables.js';
import type { Client, ControlApi, Grant } from '../kernel/backends.js';
import type { Json } from '../kernel/refs.js';
import type { Runtime } from './runtime.js';

/** A refused, malformed or unresolvable operation; `status` is the HTTP status a transport should answer with. */
export class ControlError extends Error {
  public constructor(
    message: string,
    public readonly status: 400 | 403 | 404,
  ) {
    super(message);
    this.name = 'ControlError';
  }
}

interface Operation<I = unknown> {
  readonly name: string;
  readonly input: z.ZodType<I>;
  run(runtime: Runtime, input: I, by: string): Promise<Json>;
}

const position = z.enum(['pending', 'active', 'waiting', 'terminal']);
const memoryStatus = z.enum(['candidate', 'active', 'retired']);
const window = z.object({ lastDays: z.number().positive().optional(), lastHours: z.number().positive().optional() }).optional();
const scope = z.object({
  kinds: z.array(z.string()).optional(),
  roles: z.array(z.string()).optional(),
  resources: z.array(z.string()).optional(),
  facets: z.array(z.object({ facet: z.string(), value: z.string() })).optional(),
});

function define<I>(name: string, input: z.ZodType<I>, run: (runtime: Runtime, input: I, by: string) => Promise<Json>): Operation {
  return { name, input, run } as Operation;
}

/** Every built-in operation, in the order a client lists them. */
export const OPERATIONS: readonly Operation[] = [
  define('work.create', z.object({ lane: z.string(), attributes: z.record(z.string(), z.unknown()) }), async (runtime, input, by) => {
    const unitId = await runtime.createUnit(runtime.laneNamed(input.lane), runtime.attributesFor(input.lane, input.attributes), { source: by });
    const result: Json = unitId ? { unitId } : { skipped: true };
    return result;
  }),
  define(
    'work.read',
    z.object({ unitId: z.string().optional(), lane: z.string().optional(), position: z.array(position).optional(), state: z.array(z.string()).optional(), key: z.string().optional() }),
    async (runtime, input) => {
      const records = input.unitId
        ? [await runtime.record(input.unitId)]
        : await runtime.ledger.units({
            ...(input.lane ? { lane: input.lane } : {}),
            ...(input.position ? { position: input.position } : {}),
            ...(input.state ? { state: input.state } : {}),
            ...(input.key ? { key: input.key } : {}),
          });
      return { units: records.map((record) => jsonOf(runtime.unitView(record))) };
    },
  ),
  define('work.update', z.object({ unitId: z.string(), attributes: z.record(z.string(), z.unknown()) }), async (runtime, input, by) => {
    await runtime.updateAttributes(input.unitId, input.attributes, by);
    return { applied: true };
  }),
  define('work.cancel', z.object({ unitId: z.string(), reason: z.string().optional() }), async (runtime, input, by) => {
    await runtime.cancelUnit(input.unitId, input.reason ?? `cancelled by ${by}`, by);
    return { delivered: true };
  }),
  define('work.signal', z.object({ lane: z.string(), key: z.string(), signal: z.string(), payload: z.unknown() }), async (runtime, input, by) => {
    await runtime.deliverSignal(input.lane, input.key, input.signal, (input.payload ?? null) as Json, by);
    return { delivered: true };
  }),
  define('attempts.recover', z.object({ unitId: z.string(), action: z.enum(['restartFromTop', 'abandon', 'continue']) }), async (runtime, input, by) => {
    await runtime.recover(input.unitId, input.action, by);
    return { recovered: input.action };
  }),
  define('lanes.pause', z.object({ lane: z.string(), reason: z.string() }), async (runtime, input, by) => {
    await runtime.pauseLane(input.lane, input.reason, by);
    return { paused: true };
  }),
  define('lanes.resume', z.object({ lane: z.string(), reason: z.string() }), async (runtime, input, by) => {
    await runtime.resumeLane(input.lane, input.reason, by);
    return { paused: false };
  }),
  define('halts.resolve', z.object({ unitId: z.string(), decision: z.unknown() }), async (runtime, input, by) => {
    const outcome = await runtime.resolveHalt(input.unitId, (input.decision ?? null) as Json, by);
    return { outcome: jsonOf({ kind: outcome.kind, ...('exit' in outcome ? { exit: outcome.exit } : {}), ...('step' in outcome ? { step: outcome.step } : {}), ...('on' in outcome ? { on: outcome.on } : {}), ...('ask' in outcome ? { ask: outcome.ask } : {}), ...('facets' in outcome ? { facets: outcome.facets } : {}), ...('detail' in outcome ? { detail: outcome.detail } : {}), ...('error' in outcome ? { error: outcome.error } : {}) }) };
  }),
  define('memory.read', z.object({ journal: z.string(), status: z.array(memoryStatus).optional() }), async (runtime, input) => {
    const journal = runtime.journalNamed(input.journal);
    return { items: jsonOf(await journal.memoryStore!.list({ journal: journal.name, ...(input.status ? { status: input.status } : {}) })) };
  }),
  define('memory.write', z.object({ journal: z.string(), text: z.string(), when: scope.optional(), status: z.enum(['candidate', 'active']).optional() }), async (runtime, input, by) => {
    const journal = runtime.journalNamed(input.journal);
    const named = (names: readonly string[] | undefined) => (names ?? []).map((name) => ({ name }));
    const id = await runtime.recordMemory(
      journal,
      {
        text: input.text,
        when: {
          kinds: named(input.when?.kinds),
          roles: named(input.when?.roles).map((role) => ({ entity: 'role' as const, name: role.name })),
          resources: named(input.when?.resources),
          facets: (input.when?.facets ?? []).map((facet) => ({ facet: { entity: 'facet' as const, name: facet.facet }, value: facet.value })),
        },
        ...(input.status ? { status: input.status } : {}),
      },
      by,
    );
    return { id };
  }),
  define('memory.curate', z.object({ journal: z.string(), id: z.string(), status: memoryStatus.optional(), text: z.string().optional(), mergedInto: z.string().optional() }), async (runtime, input) => {
    const journal = runtime.journalNamed(input.journal);
    await journal.memoryStore!.update(input.id, { ...(input.status ? { status: input.status } : {}), ...(input.text ? { text: input.text } : {}), ...(input.mergedInto ? { mergedInto: input.mergedInto } : {}) });
    return { curated: true };
  }),
  define('telemetry.read', z.object({ window }), async (runtime, input) =>
    jsonOf(await runtime.telemetry(input.window?.lastDays ? { lastDays: input.window.lastDays } : input.window?.lastHours ? { lastHours: input.window.lastHours } : undefined)),
  ),
  define('accounts.read', z.object({}), async (runtime) => ({ accounts: jsonOf(await runtime.accountStates()) })),
  define('accounts.share', z.object({ account: z.string(), fraction: z.number().gt(0).max(1) }), async (runtime, input, by) => {
    await runtime.shareAccount(input.account, input.fraction, by);
    return { applied: true };
  }),
];

export function jsonOf(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

function customOperation(grant: OperationDef): Operation {
  const exec = grant.exec as Executable<unknown, unknown> & { readonly inputSchema?: z.ZodType };
  return { name: grant.operation, input: exec.inputSchema ?? z.unknown(), run: async (runtime, input) => jsonOf(await runtime.runExecutable(exec, input)) };
}

function grantFor(client: Client, operation: string): Grant | undefined {
  return client.grants.find((grant) => grant.operation === operation || (operation === 'lanes.resume' && grant.operation === 'lanes.pause'));
}

/** The control API as one client sees it: only the operations its grants name, and only the halts they name. */
export function controlApiFor(runtime: Runtime, client: Client): ControlApi {
  const customs = client.grants.filter((grant): grant is OperationDef => 'exec' in grant).map(customOperation);
  const available = [...OPERATIONS.filter((operation) => grantFor(client, operation.name) !== undefined), ...customs];
  return {
    harness: runtime.harness.name,
    operations: () => available.map((operation) => ({ name: operation.name, inputSchema: z.toJSONSchema(operation.input) as Json })),
    async call(name, input, caller) {
      const operation = available.find((candidate) => candidate.name === name);
      if (!operation) throw new ControlError(`client "${client.name}" may not call "${name}"`, 403);
      const parsed = operation.input.safeParse(input);
      if (!parsed.success) throw new ControlError(`invalid input for "${name}": ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`, 400);
      if (name === 'halts.resolve') {
        const { unitId } = parsed.data as { unitId: string };
        const halt = (await runtime.record(unitId)).unit.attempt?.halt;
        if (!halt) throw new ControlError(`unit "${unitId}" is not waiting on a decision`, 400);
        if (!grantFor(client, name)?.halts?.some((candidate) => candidate.name === halt)) throw new ControlError(`client "${client.name}" may not resolve halt "${halt}"`, 403);
      }
      return operation.run(runtime, parsed.data, `client:${caller}`);
    },
    subscribe: (listener) => runtime.subscribe(listener),
  };
}
