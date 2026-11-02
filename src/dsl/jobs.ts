import type { JobRef } from '../kernel/lifecycle.js';
import type { Executable } from './executables.js';
import type { SeatDef } from './seats.js';

export interface JobHandle {
  readonly jobId: string;
}

export type JobPoll<O> =
  | { readonly state: 'running' }
  | { readonly state: 'succeeded'; readonly result: O }
  | { readonly state: 'failed'; readonly reason: string };

export class JobDef<I, O> implements Executable<I, O>, JobRef {
  public readonly entity = 'job' as const;
  public readonly name: string;
  public readonly submit: Executable<I, JobHandle> | undefined;
  public readonly collect: Executable<JobHandle, JobPoll<O>> | undefined;
  public readonly pollEveryMinutes: number;
  public readonly batchOf: SeatDef<unknown, unknown, string, true> | undefined;
  public readonly _io?: { readonly in: (input: I) => void; readonly out: O };

  public constructor(
    name: string,
    fields: {
      readonly submit?: Executable<I, JobHandle>;
      readonly collect?: Executable<JobHandle, JobPoll<O>>;
      readonly pollEveryMinutes: number;
      readonly batchOf?: SeatDef<unknown, unknown, string, true>;
    },
  ) {
    this.name = name;
    this.submit = fields.submit;
    this.collect = fields.collect;
    this.pollEveryMinutes = fields.pollEveryMinutes;
    this.batchOf = fields.batchOf;
  }
}

export function job<I, O>(
  name: string,
  spec: { readonly submit: Executable<I, JobHandle>; readonly collect: Executable<JobHandle, JobPoll<O>>; readonly pollEveryMinutes: number },
): JobDef<I, O> {
  return new JobDef<I, O>(name, spec);
}

export function batch<I, O, D extends string>(name: string, seat: SeatDef<I, O, D, true>): JobDef<readonly I[], readonly O[]> {
  return new JobDef<readonly I[], readonly O[]>(name, { pollEveryMinutes: 10, batchOf: seat as SeatDef<unknown, unknown, string, true> });
}
