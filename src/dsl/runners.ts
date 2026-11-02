import type { RunnerBackend, Workspace, WorkspaceBackend } from '../kernel/backends.js';
import type { Named } from '../kernel/refs.js';
import type { Executable } from './executables.js';
import type { ResourceSetDef } from './resources.js';

export class RunnerDef implements Named {
  public readonly entity = 'runner' as const;
  public readonly name: string;
  public readonly backend: RunnerBackend;
  public readonly slotCount: number;
  public readonly preflightCheck: Executable<void, unknown> | undefined;

  public constructor(name: string, backend: RunnerBackend, slotCount = 1, preflightCheck?: Executable<void, unknown>) {
    this.name = name;
    this.backend = backend;
    this.slotCount = slotCount;
    this.preflightCheck = preflightCheck;
  }

  public slots(count: number): RunnerDef {
    return new RunnerDef(this.name, this.backend, count, this.preflightCheck);
  }

  public preflight(check: Executable<void, unknown>): RunnerDef {
    return new RunnerDef(this.name, this.backend, this.slotCount, check);
  }
}

export function defineRunner(name: string, backend: RunnerBackend): RunnerDef {
  return new RunnerDef(name, backend);
}

export class WorkspaceDef implements Workspace {
  public readonly entity = 'workspace' as const;
  public readonly name: string;
  public readonly backend: WorkspaceBackend;
  public readonly areas: Readonly<Record<string, readonly string[]>>;
  public readonly areaSet: ResourceSetDef<string> | undefined;

  public constructor(name: string, backend: WorkspaceBackend, areas: Readonly<Record<string, readonly string[]>> = {}, areaSet?: ResourceSetDef<string>) {
    this.name = name;
    this.backend = backend;
    this.areas = areas;
    this.areaSet = areaSet;
  }

  public withAreas<V extends string>(set: ResourceSetDef<V>, globs: Readonly<Record<V, readonly string[]>>): WorkspaceDef {
    const areas = Object.fromEntries(Object.entries(globs).map(([value, patterns]) => [set.of(value as V).name, patterns as readonly string[]]));
    return new WorkspaceDef(this.name, this.backend, areas, set as ResourceSetDef<string>);
  }
}

export function defineWorkspace(name: string, backend: WorkspaceBackend): WorkspaceDef {
  return new WorkspaceDef(name, backend);
}
