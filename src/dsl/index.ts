import type { EnvRef, PortRef } from '../kernel/refs.js';
import { operation, ops } from './clients.js';
import { command } from './commands.js';
import { flow } from './flows.js';
import { cancel, halt, signal } from './halts.js';
import { harness } from './harness.js';
import { batch, job } from './jobs.js';
import { kind, state, terminal } from './kinds.js';
import { lane, operator } from './lanes.js';
import { journal, memory } from './memory.js';
import { metric } from './metrics.js';
import { policy } from './policies.js';
import { pool } from './pools.js';
import { facet, resource, resources } from './resources.js';
import { role } from './roles.js';
import { scheduler } from './scheduler.js';
import { seat } from './seats.js';
import { when } from './sources.js';
import { trigger } from './triggers.js';

export const H = {
  /** An environment variable, or with `index` one of the comma-separated values it holds. */
  env(name: string, options: { readonly index?: number } = {}): EnvRef {
    return { ref: 'env', name, ...(options.index !== undefined ? { index: options.index } : {}) };
  },
  slot: {
    port(slot: number): PortRef {
      return { ref: 'port', slot };
    },
  },
  state,
  terminal,
  kind,
  signal,
  cancel,
  halt,
  resource,
  resources,
  facet,
  role,
  memory,
  journal,
  pool,
  seat,
  command,
  job,
  batch,
  flow,
  lane,
  operator,
  trigger,
  when,
  metric,
  policy,
  scheduler,
  ops,
  operation,
  harness,
} as const;

export { validate, type Problem } from './validate.js';
export type { CommandDef, CommandResult, DetectCtx, Effect as CommandEffect } from './commands.js';
export type { FlowCtx, FlowDef, FlowNode, HaltOptions, LoopBounds, Retry, StepOptions } from './flows.js';
export type { HaltDef, SignalDef } from './halts.js';
export type { HarnessDef } from './harness.js';
export type { JobDef, JobHandle, JobPoll } from './jobs.js';
export type { Empty, KindDef, KindShape, PendingState, Schema, StateDef, TerminalState, WaitingState } from './kinds.js';
export type { Ceiling, LaneDef, LaneShape, Lease, Reaction, RetryPolicy, Route, Router, StoreMap } from './lanes.js';
export type { JournalDef, MemoryDraft, MemoryKindDef, RecallCandidate, Trust } from './memory.js';
export type { Amount, AnyMetric, MetricDef, Sample } from './metrics.js';
export type { AccountPolicyDef, AdmitPolicyDef, HaltPolicyDef, ModelPolicyDef, PolicyDef, RecallPolicyDef, RunnerPolicyDef } from './policies.js';
export type { PoolDef } from './pools.js';
export type { FacetDef, ResourceDef, ResourceSetDef } from './resources.js';
export type { Intent, RoleDef } from './roles.js';
export { defineRunner, defineWorkspace, RunnerDef, WorkspaceDef } from './runners.js';
export type { SchedulerDef } from './scheduler.js';
export type { SeatDef } from './seats.js';
export type { Band, CrossingEvent, DecisionEvent, GroupCrossingEvent, InvocationEvent, PatternEvent, Source, StepEvent, Threshold, TransitionEvent, UnitEvent } from './sources.js';
export type { Actions, AnyTrigger, Consequence, Effect, TriggerDef } from './triggers.js';
export type { AttemptView, ChildResult, UnitView } from './views.js';
export type { Executable } from './executables.js';
export type { OperationDef } from './clients.js';
