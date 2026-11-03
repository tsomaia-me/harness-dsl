import type { Grant } from '../kernel/backends.js';
import type { HaltRef } from '../kernel/lifecycle.js';
import type { Named } from '../kernel/refs.js';
import type { Executable } from './executables.js';

function grant(operation: string): Grant {
  return { entity: 'grant', operation };
}

export const ops = {
  work: {
    read: grant('work.read'),
    create: grant('work.create'),
    update: grant('work.update'),
    cancel: grant('work.cancel'),
    signal: grant('work.signal'),
  },
  attempts: { recover: grant('attempts.recover') },
  lanes: { pause: grant('lanes.pause') },
  memory: { read: grant('memory.read'), write: grant('memory.write'), curate: grant('memory.curate') },
  telemetry: { read: grant('telemetry.read') },
  accounts: { read: grant('accounts.read'), share: grant('accounts.share') },
  resolve(...halts: readonly HaltRef[]): Grant {
    return { entity: 'grant', operation: 'halts.resolve', halts };
  },
} as const;

export interface OperationDef<I = unknown, O = unknown> extends Named, Grant {
  readonly entity: 'grant';
  readonly operation: string;
  readonly exec: Executable<I, O>;
}

export function operation<I, O>(name: string, exec: Executable<I, O>): OperationDef<I, O> {
  return { entity: 'grant', name, operation: `custom.${name}`, exec };
}
