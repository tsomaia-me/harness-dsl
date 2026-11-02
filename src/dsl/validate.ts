import type { State } from '../kernel/lifecycle.js';
import type { Named } from '../kernel/refs.js';
import type { CommandDef } from './commands.js';
import type { FlowDef, FlowNode, HaltOptions } from './flows.js';
import type { HaltDef } from './halts.js';
import type { HarnessDef } from './harness.js';
import type { KindDef } from './kinds.js';
import type { LaneAny, LaneDef } from './lanes.js';
import type { ModelPolicyDef } from './policies.js';
import type { SeatDef } from './seats.js';

export interface Problem {
  readonly rule: number;
  readonly message: string;
}

/** The dimensions a stored event carries (kernel `StoredDimensions`); a facet or resource set may not shadow one. */
const LEDGER_COLUMNS = new Set(['kind', 'lane', 'state', 'seat', 'model', 'resource', 'halt']);

type AnyLane = LaneDef<unknown, State, unknown, string>;
type AnyFlow = FlowDef<unknown, unknown, unknown, string, string>;
type AnySeat = SeatDef<unknown, unknown, string, boolean>;
type AnyCommand = CommandDef<unknown, unknown>;
type AnyHalt = HaltDef<string, unknown>;
type AnyHaltOptions = HaltOptions<unknown, unknown, Record<string, unknown>, unknown>;

interface HaltAddress {
  readonly lane: AnyLane;
  readonly node: Extract<FlowNode, { type: 'halt' }>;
  readonly path: string;
}

interface Visit {
  readonly path: string;
  readonly loops: number;
  /** Inside a `when` or `loop` body, whose steps land in the same `ctx.steps` as their siblings. */
  readonly nested: boolean;
}

function walk(nodes: readonly FlowNode[], path: string, visit: (node: FlowNode, at: Visit) => void, loops = 0, nested = false): void {
  for (const node of nodes) {
    const here = `${path}/${node.name}`;
    visit(node, { path: here, loops, nested });
    if (node.type === 'when') walk(node.nodes, here, visit, loops, true);
    if (node.type === 'loop') walk(node.nodes, here, visit, loops + 1, true);
  }
}

function exitsOf(flow: AnyFlow): Set<string> {
  const exits = new Set<string>();
  walk(flow.nodes, '', (node) => {
    if (node.type === 'exit') exits.add(node.name);
  });
  return exits;
}

function endsWithUnconditionalExit(nodes: readonly FlowNode[]): boolean {
  const last = nodes[nodes.length - 1];
  return last !== undefined && last.type === 'exit' && last.when === undefined;
}

/** Names that two distinct descriptors of one sort share. */
function sharedNames(items: Iterable<Named>): string[] {
  const byName = new Map<string, Set<Named>>();
  for (const item of items) byName.set(item.name, new Set([...(byName.get(item.name) ?? []), item]));
  return [...byName.entries()].filter(([, owners]) => owners.size > 1).map(([name]) => name);
}

function isCommand(exec: Named | undefined): exec is AnyCommand {
  return (exec as { readonly entity?: string } | undefined)?.entity === 'command';
}

export function validate(harness: HarnessDef): readonly Problem[] {
  const problems: Problem[] = [];
  const fail = (rule: number, message: string): void => {
    problems.push({ rule, message });
  };

  const lanes = harness.laneList as readonly AnyLane[];
  const kinds = lanes.map((lane) => lane.kind as KindDef<string, unknown, State>);
  const flows: { readonly lane: AnyLane; readonly flow: AnyFlow }[] = [];
  const seats = new Set<AnySeat>();
  const commands = new Set<AnyCommand>();
  const haltAddresses: HaltAddress[] = [];
  const haltsAsked = new Set<AnyHalt>();
  /** Halts with no clock and no policy: a client must be able to resolve them. */
  const haltsNeedingResolver: { readonly halt: AnyHalt; readonly where: string }[] = [];
  const metricsRead = new Set<string>();
  const facets = new Set<Named>();
  const resourceSets = new Set<Named>();
  const workspaces = new Set<Named>();
  const runners = new Set<Named>();
  const policies = new Set<Named>();
  const signals = new Set<Named>();

  const notePolicy = (policy: Named | undefined): void => {
    if (policy) policies.add(policy);
  };
  const noteCommand = (exec: Named | undefined): void => {
    if (isCommand(exec)) commands.add(exec);
  };
  const noteSeat = (seat: AnySeat): void => {
    seats.add(seat);
    if (seat.modelChoice?.entity === 'policy') notePolicy(seat.modelChoice);
  };

  for (const lane of lanes) {
    for (const { signal } of lane.reactions) signals.add(signal);
    if (lane.ceilingOf) {
      haltsAsked.add(lane.ceilingOf.onExceed);
      haltsNeedingResolver.push({ halt: lane.ceilingOf.onExceed, where: `the ceiling of lane "${lane.name}"` });
    }
    if (!lane.handlerDef) {
      fail(3, `lane "${lane.name}" has no handler`);
      continue;
    }
    const flow = lane.handlerDef.flow;
    flows.push({ lane, flow });
    walk(flow.nodes, '', (node, at) => {
      if (node.type === 'step') {
        const exec = node.exec;
        if (exec.entity === 'seat') noteSeat(exec as AnySeat);
        else if (exec.entity === 'command') noteCommand(exec);
        else if (exec.entity === 'job') {
          const job = exec as { readonly submit?: Named; readonly collect?: Named; readonly batchOf?: AnySeat };
          noteCommand(job.submit);
          noteCommand(job.collect);
          if (job.batchOf) noteSeat(job.batchOf);
        }
        for (const raised of node.options.halts ?? []) {
          haltsAsked.add(raised);
          haltsNeedingResolver.push({ halt: raised, where: `step "${at.path}" in lane "${lane.name}"` });
        }
        if ((node.options.workspace || node.options.guard || node.options.halts) && exec.entity !== 'seat') {
          fail(11, `step "${at.path}" in lane "${lane.name}" carries seat options on a ${exec.entity}`);
        }
        const leases = node.options.guard?.leases;
        const workspace = node.options.workspace;
        if (leases) resourceSets.add(leases);
        if (workspace) {
          workspaces.add(workspace);
          if (workspace.areaSet) resourceSets.add(workspace.areaSet);
        }
        noteCommand(node.options.guard?.beforeStop);
        if (leases && workspace && !leases.all.every((resource) => resource.name in workspace.areas)) {
          fail(14, `step "${at.path}" in lane "${lane.name}" leases "${leases.name}" but workspace "${workspace.name}" maps no areas for it`);
        }
        if (leases && !workspace) fail(14, `step "${at.path}" in lane "${lane.name}" leases "${leases.name}" without a workspace`);
      }
      if (node.type === 'parallel') {
        for (const branch of Object.values(node.branches)) {
          const exec = 'exec' in branch ? branch.exec : branch;
          if (exec.entity === 'seat') noteSeat(exec as AnySeat);
          else noteCommand(exec);
        }
      }
      if (node.type === 'halt') {
        haltAddresses.push({ lane, node, path: at.path });
        haltsAsked.add(node.halt);
        const options = node.options as AnyHaltOptions;
        if (options.timeout && options.escalate && options.timeout.afterMinutes <= options.escalate.afterMinutes) {
          fail(16, `halt "${at.path}" in lane "${lane.name}" times out at ${options.timeout.afterMinutes} minutes, not later than its escalation at ${options.escalate.afterMinutes}`);
        }
        if (options.skip) {
          notePolicy(options.skip);
          if (options.skip.halt.name !== node.halt.name) fail(16, `halt "${at.path}" in lane "${lane.name}" is skipped by policy "${options.skip.name}" declared for halt "${options.skip.halt.name}"`);
          if (options.skip.kind.name !== lane.kind.name) fail(16, `halt "${at.path}" in lane "${lane.name}" is skipped by policy "${options.skip.name}" declared for kind "${options.skip.kind.name}"`);
        }
        noteCommand(options.escalate?.run);
        if (!options.timeout && !options.skip) haltsNeedingResolver.push({ halt: node.halt, where: `halt "${at.path}" in lane "${lane.name}"` });
      }
      if (node.type === 'read') metricsRead.add(node.metric.name);
      if (node.type === 'spawn' && !lanes.some((candidate) => candidate.name === node.lane.name)) {
        fail(8, `spawn "${at.path}" in lane "${lane.name}" targets lane "${node.lane.name}", which is not registered`);
      }
      if (node.type === 'loop' && node.bounds.span === 'unit' && at.loops > 0) {
        fail(21, `loop "${at.path}" in lane "${lane.name}" spans the unit inside another loop`);
      }
    });
  }

  for (const seat of seats) {
    if (seat.poolDef) {
      notePolicy(seat.poolDef.drainPolicy);
    }
  }
  for (const command of commands) {
    const choice = command.runnerChoice;
    if (choice?.entity === 'runner') runners.add(choice);
    if (choice?.entity === 'policy') {
      notePolicy(choice);
      for (const runner of (choice as { readonly candidates: readonly Named[] }).candidates) runners.add(runner);
    }
  }
  for (const grant of harness.clientList.flatMap((client) => client.grants)) {
    const operation = grant as { readonly exec?: Named };
    noteCommand(operation.exec);
  }
  for (const journal of harness.journalList) notePolicy(journal.recallPolicy);
  if (harness.schedulerDef) for (const { policy } of harness.schedulerDef.admits) notePolicy(policy);

  const sorts: readonly [string, Iterable<Named>][] = [
    ['lane', lanes],
    ['kind', kinds],
    ['journal', harness.journalList],
    ['memory kind', harness.journalList.map((journal) => journal.memoryKind)],
    ['trigger', harness.triggerList],
    ['metric', harness.metricList],
    ['client', harness.clientList],
    ['observer', harness.observerList],
    ['seat', seats],
    ['role', [...seats].flatMap((seat) => (seat.roleDef ? [seat.roleDef] : []))],
    ['pool', [...seats].flatMap((seat) => (seat.poolDef ? [seat.poolDef] : []))],
    ['command', commands],
    ['runner', runners],
    ['workspace', workspaces],
    ['policy', policies],
    ['halt', haltsAsked],
    ['signal', signals],
    ['resource set', resourceSets],
    ['flow', new Set(flows.map((entry) => entry.flow))],
  ];
  for (const [sort, items] of sorts) {
    for (const name of sharedNames(items)) fail(1, `two ${sort}s are named "${name}"`);
  }
  for (const kind of new Set(kinds)) {
    for (const name of sharedNames(kind.stateList)) fail(1, `kind "${kind.name}" declares two states named "${name}"`);
  }

  for (const lane of lanes) {
    const kind = lane.kind as KindDef<string, unknown, State>;
    const initial = kind.initialState as State | undefined;
    if (initial === undefined) fail(5, `kind "${kind.name}" declares no initial state`);
    else if (initial.position !== 'pending') fail(5, `kind "${kind.name}" has initial state "${initial.name}" at position ${initial.position}`);
    const stateNames = new Set(kind.stateList.map((state) => state.name));
    if (lane.storeDef && !lane.storeDef.creates && lane.supplies.some((supply) => supply.route !== undefined)) {
      fail(20, `lane "${lane.name}" is supplied but its store "${lane.storeDef.name}" cannot create units`);
    }
    if (lane.handlerDef) {
      const flow = lane.handlerDef.flow;
      const exits = exitsOf(flow);
      for (const exit of exits) {
        if (!(exit in lane.handlerDef.exits)) fail(3, `lane "${lane.name}" maps no state for exit "${exit}" of flow "${flow.name}"`);
      }
      for (const [exit, state] of Object.entries(lane.handlerDef.exits)) {
        if (!exits.has(exit)) fail(3, `lane "${lane.name}" maps exit "${exit}", which flow "${flow.name}" never reaches`);
        if (!stateNames.has(state.name)) fail(3, `lane "${lane.name}" maps exit "${exit}" to state "${state.name}", which kind "${kind.name}" does not declare`);
      }
      if (!endsWithUnconditionalExit(flow.nodes)) fail(4, `flow "${flow.name}" in lane "${lane.name}" does not end with an unconditional exit`);
      const seen = new Map<string, Visit[]>();
      walk(flow.nodes, '', (node, at) => seen.set(node.name, [...(seen.get(node.name) ?? []), at]));
      for (const [name, visits] of seen) {
        if (visits.length < 2) continue;
        if (visits.some((visit) => visit.nested)) fail(22, `flow "${flow.name}" uses the name "${name}" in a branch body and beside it: both land in the same steps`);
        else fail(4, `flow "${flow.name}" uses the name "${name}" twice`);
      }
      const top = flow.nodes.map((node) => node.name);
      for (const { signal, reaction } of lane.reactions) {
        const at = reaction.at ?? [];
        for (const step of [...at, ...(reaction.rewind ? [reaction.rewind] : [])]) {
          if (!top.includes(step)) fail(10, `lane "${lane.name}" reacts to "${signal.name}" at step "${step}", which flow "${flow.name}" lacks at its top level`);
        }
        if (reaction.rewind && at.length > 0) {
          const target = top.indexOf(reaction.rewind);
          for (const step of at) {
            if (top.indexOf(step) < target) fail(10, `lane "${lane.name}" rewinds "${signal.name}" to "${reaction.rewind}", which does not precede "${step}"`);
          }
        }
      }
      if (lane.storeMap) {
        for (const name of stateNames) {
          if (!(name in lane.storeMap.states)) fail(6, `lane "${lane.name}" maps no store status for state "${name}"`);
        }
      }
      const exhausted = lane.retryPolicy?.exhausted as State | { readonly state: State } | undefined;
      if (exhausted && 'state' in exhausted && exhausted.state.position !== 'waiting') {
        fail(7, `lane "${lane.name}" reopens exhaustion from "${exhausted.state.name}", which is not a waiting state`);
      }
      if (exhausted && !('state' in exhausted) && exhausted.position !== 'terminal') {
        fail(7, `lane "${lane.name}" exhausts to "${exhausted.name}", which is not terminal and has no reopenAfter`);
      }
    }
  }

  for (const seat of seats) {
    if (!seat.poolDef) {
      fail(11, `seat "${seat.name}" has no pool`);
    } else if (seat.modelChoice) {
      const drivers = seat.modelChoice.entity === 'policy' ? (seat.modelChoice as ModelPolicyDef).candidates.map((model) => model.driver) : [seat.modelChoice.driver];
      for (const driver of drivers) {
        if (!seat.poolDef.accountList.some((account) => account.driver === driver)) {
          fail(11, `seat "${seat.name}" chooses a model of driver "${driver}" that no account of pool "${seat.poolDef.name}" can serve`);
        }
      }
    } else {
      fail(11, `seat "${seat.name}" has no model`);
    }
    if (!seat.roleDef) fail(11, `seat "${seat.name}" has no role`);
  }

  const sharers = new Map<string, number>();
  for (const seat of seats) {
    const choice = seat.modelChoice;
    if (choice?.entity === 'policy' && (choice as ModelPolicyDef).distinct) sharers.set(choice.name, (sharers.get(choice.name) ?? 0) + 1);
  }
  for (const seat of seats) {
    const choice = seat.modelChoice;
    if (choice?.entity === 'policy' && (choice as ModelPolicyDef).distinct) {
      const count = sharers.get(choice.name) ?? 0;
      if ((choice as ModelPolicyDef).candidates.length < count) fail(12, `policy "${choice.name}" is shared by ${count} seats but has ${(choice as ModelPolicyDef).candidates.length} candidates`);
    }
  }

  for (const command of commands) {
    if (!command.argvOf) fail(19, `command "${command.name}" has no argv`);
    if (!command.runnerChoice) fail(19, `command "${command.name}" has no runner`);
    if (command.effectKind === 'external' && !command.detect) fail(19, `command "${command.name}" has an external effect without detect`);
    if (command.effectKind === 'external' && command.outputSchema) fail(19, `command "${command.name}" has an external effect and an output schema; after detect reports the effect happened, no output exists to parse`);
  }

  const resolvable = new Set<string>();
  for (const client of harness.clientList) {
    for (const grant of client.grants) for (const halt of grant.halts ?? []) resolvable.add(halt.name);
  }
  const askedNames = new Set([...haltsAsked].map((halt) => halt.name));
  for (const client of harness.clientList) {
    for (const grant of client.grants) {
      for (const halt of grant.halts ?? []) {
        if (!askedNames.has(halt.name)) fail(15, `client "${client.name}" may resolve halt "${halt.name}", which no flow asks`);
      }
    }
  }
  for (const { halt, where } of haltsNeedingResolver) {
    if (!resolvable.has(halt.name)) fail(15, `${where} asks "${halt.name}", which no client can resolve and which has neither a timeout nor a policy`);
  }
  void haltAddresses;

  const registeredMetrics = new Set(harness.metricList.map((metric) => metric.name));
  for (const name of metricsRead) {
    if (!registeredMetrics.has(name)) fail(17, `a flow reads metric "${name}", which the harness does not register`);
  }

  const partitions = new Map<string, string>();
  for (const seat of seats) {
    for (const account of seat.poolDef?.accountList ?? []) {
      const known = partitions.get(account.name);
      if (known !== undefined && known !== account.quota.name) fail(18, `account "${account.name}" is bound to partitions "${known}" and "${account.quota.name}"`);
      partitions.set(account.name, account.quota.name);
    }
  }
  for (const { account, fraction } of harness.shares) {
    if (!(fraction > 0 && fraction <= 1)) fail(18, `share ${fraction} on account "${account.name}" is outside (0, 1]`);
  }

  if (harness.schedulerDef) {
    const scheduler = harness.schedulerDef;
    const classes = new Map<string, number>();
    const count = (lane: LaneAny): void => {
      classes.set(lane.name, (classes.get(lane.name) ?? 0) + 1);
    };
    for (const { lane } of scheduler.expedites) count(lane);
    for (const { lane } of scheduler.fixedDates) count(lane);
    for (const lane of scheduler.standards) count(lane);
    for (const lane of lanes) {
      const n = classes.get(lane.name) ?? 0;
      if (n === 0) fail(8, `lane "${lane.name}" is in no scheduler class`);
      if (n > 1) fail(8, `lane "${lane.name}" is in ${n} scheduler classes`);
    }
    const referenced = [
      ...scheduler.expedites.flatMap((entry) => [entry.lane, ...entry.holds]),
      ...scheduler.fixedDates.map((entry) => entry.lane),
      ...scheduler.standards,
      ...scheduler.wips.flatMap((entry) => entry.lanes),
      ...scheduler.agings.map((entry) => entry.lane),
      ...scheduler.admits.map((entry) => entry.lane),
    ];
    for (const lane of referenced) {
      if (!lanes.some((candidate) => candidate.name === lane.name)) fail(8, `scheduler "${scheduler.name}" references lane "${lane.name}", which is not registered`);
    }
  } else {
    for (const lane of lanes) fail(8, `lane "${lane.name}" is in no scheduler class: the harness has no scheduler`);
  }

  const registeredLane = (lane: Named): boolean => lanes.some((candidate) => candidate.name === lane.name);
  const sources = [...harness.triggerList.map((trigger) => ({ owner: `trigger "${trigger.name}"`, spec: trigger.source?.spec })), ...harness.metricList.map((metric) => ({ owner: `metric "${metric.name}"`, spec: metric.source.spec }))];
  for (const trigger of harness.triggerList) {
    if (!trigger.source) fail(8, `trigger "${trigger.name}" has no source`);
    if (!trigger.consequence) fail(8, `trigger "${trigger.name}" has no consequence`);
  }
  for (const { owner, spec } of sources) {
    if (!spec) continue;
    if ('lane' in spec && !registeredLane(spec.lane)) fail(8, `${owner} watches lane "${spec.lane.name}", which is not registered`);
    if ('lanes' in spec) for (const lane of spec.lanes) if (!registeredLane(lane)) fail(8, `${owner} watches lane "${lane.name}", which is not registered`);
    if (spec.on === 'crossing' && !registeredMetrics.has(spec.metric.name)) fail(17, `${owner} crosses metric "${spec.metric.name}", which the harness does not register`);
    if (spec.on === 'crossing' && spec.metric.measure !== 'rate') fail(17, `${owner} crosses a total metric`);
    if (spec.on === 'crossing' && spec.per) facets.add(spec.per);
  }

  const cancelGranted = harness.clientList.some((client) => client.grants.some((grant) => grant.operation === 'work.cancel'));
  if (cancelGranted) {
    for (const lane of lanes) {
      if (!lane.reactions.some(({ signal }) => signal.name === 'cancel')) fail(9, `lane "${lane.name}" has no reaction to cancel, which a client may send`);
    }
  }

  for (const facet of facets) {
    if (LEDGER_COLUMNS.has(facet.name)) fail(2, `facet "${facet.name}" is named like a ledger column`);
  }
  for (const set of resourceSets) {
    if (LEDGER_COLUMNS.has(set.name)) fail(2, `resource set "${set.name}" is named like a ledger column`);
  }

  if (!harness.ledgerDef) fail(0, `harness "${harness.name}" has no ledger`);

  return problems;
}
