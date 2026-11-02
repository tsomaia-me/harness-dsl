import type { HaltRef, State } from '../kernel/lifecycle.js';
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

const LEDGER_COLUMNS = new Set(['kind', 'lane', 'state', 'seat', 'model', 'resource', 'halt', 'resolver']);

type AnyLane = LaneDef<unknown, State, unknown, string>;
type AnyFlow = FlowDef<unknown, unknown, unknown, string, string>;
type AnySeat = SeatDef<unknown, unknown, string, boolean>;
type AnyCommand = CommandDef<unknown, unknown>;
type AnyHalt = HaltDef<string, unknown>;

interface HaltAddress {
  readonly lane: AnyLane;
  readonly node: Extract<FlowNode, { type: 'halt' }>;
  readonly path: string;
}

function walk(nodes: readonly FlowNode[], path: string, visit: (node: FlowNode, path: string, depth: { readonly loops: number }) => void, loops = 0): void {
  for (const node of nodes) {
    const here = `${path}/${node.name}`;
    visit(node, here, { loops });
    if (node.type === 'when') walk(node.nodes, here, visit, loops);
    if (node.type === 'loop') walk(node.nodes, here, visit, loops + 1);
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

function topLevelNames(flow: AnyFlow): string[] {
  return flow.nodes.map((node) => node.name);
}

function duplicates(items: readonly Named[]): string[] {
  const seen = new Map<string, number>();
  for (const item of items) seen.set(item.name, (seen.get(item.name) ?? 0) + 1);
  return [...seen.entries()].filter(([, count]) => count > 1).map(([name]) => name);
}

export function validate(harness: HarnessDef): readonly Problem[] {
  const problems: Problem[] = [];
  const fail = (rule: number, message: string): void => {
    problems.push({ rule, message });
  };

  const lanes = harness.laneList as readonly AnyLane[];
  const kinds = new Map<string, KindDef<string, unknown, State>>();
  for (const lane of lanes) kinds.set(lane.kind.name, lane.kind as KindDef<string, unknown, State>);
  const flows: { readonly lane: AnyLane; readonly flow: AnyFlow }[] = [];
  const seats = new Map<AnySeat, AnySeat>();
  const commands = new Map<AnyCommand, AnyCommand>();
  const haltAddresses: HaltAddress[] = [];
  const haltsAsked = new Map<string, AnyHalt>();
  const metricsRead = new Set<string>();
  const facetNames: Named[] = [];
  const resourceSetNames: Named[] = [];

  for (const lane of lanes) {
    if (!lane.handlerDef) {
      fail(3, `lane "${lane.name}" has no handler`);
      continue;
    }
    const flow = lane.handlerDef.flow;
    flows.push({ lane, flow });
    walk(flow.nodes, '', (node, path, depth) => {
      if (node.type === 'step') {
        const exec = node.exec;
        if (exec.entity === 'seat') {
          seats.set(exec as AnySeat, exec as AnySeat);
        } else if (exec.entity === 'command') {
          commands.set(exec as AnyCommand, exec as AnyCommand);
        } else if (exec.entity === 'job') {
          const job = exec as { readonly submit?: AnyCommand; readonly collect?: AnyCommand };
          if (job.submit?.entity === 'command') commands.set(job.submit, job.submit);
          if (job.collect?.entity === 'command') commands.set(job.collect, job.collect);
        }
        for (const raised of node.options.halts ?? []) haltsAsked.set(raised.name, raised);
        if ((node.options.workspace || node.options.guard || node.options.halts) && exec.entity !== 'seat') {
          fail(11, `step "${path}" in lane "${lane.name}" carries seat options on a ${exec.entity}`);
        }
        const leases = node.options.guard?.leases;
        const workspace = node.options.workspace;
        if (leases && workspace && !leases.all.every((resource) => resource.name in workspace.areas)) {
          fail(14, `step "${path}" in lane "${lane.name}" leases "${leases.name}" but workspace "${workspace.name}" maps no areas for it`);
        }
        if (leases && !workspace) fail(14, `step "${path}" in lane "${lane.name}" leases "${leases.name}" without a workspace`);
      }
      if (node.type === 'halt') {
        haltAddresses.push({ lane, node, path });
        haltsAsked.set(node.halt.name, node.halt);
        const options = node.options as HaltOptions<unknown, unknown, unknown, unknown>;
        if (options.timeout && options.escalate && options.timeout.afterMinutes <= options.escalate.afterMinutes) {
          fail(16, `halt "${path}" in lane "${lane.name}" times out at ${options.timeout.afterMinutes} minutes, not later than its escalation at ${options.escalate.afterMinutes}`);
        }
        if (options.skip && options.skip.halt.name !== node.halt.name) {
          fail(16, `halt "${path}" in lane "${lane.name}" is skipped by policy "${options.skip.name}" declared for halt "${options.skip.halt.name}"`);
        }
        if (options.skip && options.skip.kind.name !== lane.kind.name) {
          fail(16, `halt "${path}" in lane "${lane.name}" is skipped by policy "${options.skip.name}" declared for kind "${options.skip.kind.name}"`);
        }
      }
      if (node.type === 'read') metricsRead.add(node.metric.name);
      if (node.type === 'spawn' && !lanes.some((candidate) => candidate.name === node.lane.name)) {
        fail(8, `spawn "${path}" in lane "${lane.name}" targets lane "${node.lane.name}", which is not registered`);
      }
      if (node.type === 'loop' && node.bounds.span === 'unit' && depth.loops > 0) {
        fail(21, `loop "${path}" in lane "${lane.name}" spans the unit inside another loop`);
      }
    });
  }

  for (const [sort, items] of [
    ['lane', lanes],
    ['kind', [...kinds.values()]],
    ['journal', harness.journalList],
    ['trigger', harness.triggerList],
    ['metric', harness.metricList],
    ['client', harness.clientList],
    ['observer', harness.observerList],
    ['seat', [...seats.values()]],
    ['command', [...commands.values()]],
    ['flow', [...new Set(flows.map((entry) => entry.flow))]],
  ] as const) {
    for (const name of duplicates(items)) fail(1, `two ${sort}s are named "${name}"`);
  }

  for (const lane of lanes) {
    const kind = lane.kind as KindDef<string, unknown, State>;
    const initial = kind.initialState as State | undefined;
    if (initial === undefined) fail(5, `kind "${kind.name}" declares no initial state`);
    else if (initial.position !== 'pending') fail(5, `kind "${kind.name}" has initial state "${initial.name}" at position ${initial.position}`);
    const stateNames = new Set(kind.stateList.map((state) => state.name));
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
      const names: string[] = [];
      walk(flow.nodes, '', (node) => names.push(node.name));
      for (const name of duplicates(names.map((name) => ({ name })))) fail(22, `flow "${flow.name}" uses the name "${name}" twice`);
      const top = topLevelNames(flow);
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

  for (const seat of seats.values()) {
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
  for (const seat of seats.values()) {
    const choice = seat.modelChoice;
    if (choice?.entity === 'policy' && (choice as ModelPolicyDef).distinct) sharers.set(choice.name, (sharers.get(choice.name) ?? 0) + 1);
  }
  for (const seat of seats.values()) {
    const choice = seat.modelChoice;
    if (choice?.entity === 'policy' && (choice as ModelPolicyDef).distinct) {
      const count = sharers.get(choice.name) ?? 0;
      if ((choice as ModelPolicyDef).candidates.length < count) fail(12, `policy "${choice.name}" is shared by ${count} seats but has ${(choice as ModelPolicyDef).candidates.length} candidates`);
    }
  }

  for (const command of commands.values()) {
    if (!command.argvOf) fail(19, `command "${command.name}" has no argv`);
    if (!command.runnerChoice) fail(19, `command "${command.name}" has no runner`);
    if (command.effectKind === 'external' && !command.detect) fail(19, `command "${command.name}" has an external effect without detect`);
    if (command.effectKind === 'external' && command.outputSchema) fail(19, `command "${command.name}" has an external effect and an output schema; after detect reports the effect happened, no output exists to parse`);
  }

  const resolvable = new Set<string>();
  for (const client of harness.clientList) {
    for (const grant of client.grants) for (const halt of grant.halts ?? []) resolvable.add(halt.name);
  }
  for (const client of harness.clientList) {
    for (const grant of client.grants) {
      for (const halt of grant.halts ?? []) {
        if (!haltsAsked.has(halt.name)) fail(15, `client "${client.name}" may resolve halt "${halt.name}", which no flow asks`);
      }
    }
  }
  for (const { lane, node, path } of haltAddresses) {
    const options = node.options as HaltOptions<unknown, unknown, unknown, unknown>;
    if (!resolvable.has(node.halt.name) && !options.timeout && !options.skip) {
      fail(15, `halt "${path}" in lane "${lane.name}" can be resolved by no client and has neither a timeout nor a policy`);
    }
  }

  const registeredMetrics = new Set(harness.metricList.map((metric) => metric.name));
  for (const name of metricsRead) {
    if (!registeredMetrics.has(name)) fail(17, `a flow reads metric "${name}", which the harness does not register`);
  }

  const partitions = new Map<string, string>();
  const accounts = new Map<string, HaltRef | Named>();
  for (const seat of seats.values()) {
    for (const account of seat.poolDef?.accountList ?? []) {
      accounts.set(account.name, account);
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
  }

  for (const trigger of harness.triggerList) {
    if (!trigger.source) fail(8, `trigger "${trigger.name}" has no source`);
    if (!trigger.consequence) fail(8, `trigger "${trigger.name}" has no consequence`);
    const spec = trigger.source?.spec;
    if (spec && 'lane' in spec && !lanes.some((candidate) => candidate.name === spec.lane.name)) {
      fail(8, `trigger "${trigger.name}" watches lane "${spec.lane.name}", which is not registered`);
    }
    if (spec?.on === 'crossing' && !registeredMetrics.has(spec.metric.name)) fail(17, `trigger "${trigger.name}" crosses metric "${spec.metric.name}", which the harness does not register`);
    if (spec?.on === 'crossing' && spec.metric.measure !== 'rate') fail(17, `trigger "${trigger.name}" crosses a total metric`);
    if (spec?.on === 'crossing' && spec.per) facetNames.push(spec.per);
  }

  const cancelGranted = harness.clientList.some((client) => client.grants.some((grant) => grant.operation === 'work.cancel'));
  if (cancelGranted) {
    for (const lane of lanes) {
      if (!lane.reactions.some(({ signal }) => signal.name === 'cancel')) fail(9, `lane "${lane.name}" has no reaction to cancel, which a client may send`);
    }
  }

  for (const facet of facetNames) {
    if (LEDGER_COLUMNS.has(facet.name)) fail(2, `facet "${facet.name}" is named like a ledger column`);
  }
  for (const set of resourceSetNames) {
    if (LEDGER_COLUMNS.has(set.name)) fail(2, `resource set "${set.name}" is named like a ledger column`);
  }

  if (!harness.ledgerDef) fail(0, `harness "${harness.name}" has no ledger`);

  return problems;
}
