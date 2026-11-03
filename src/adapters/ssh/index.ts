import { defineRunner, type RunnerDef } from '../../dsl/runners.js';
import type { RunnerBackend } from '../../kernel/backends.js';
import type { EnvRef } from '../../kernel/refs.js';
import { localBackend } from '../local/index.js';
import { SshRunner } from '../../runner.js';

export interface SshHostOptions {
  readonly host: string;
  readonly user?: string;
  /** The environment variable naming the private key file `ssh -i` signs in with; the agent's keys serve when none is given. */
  readonly key?: EnvRef;
  /** Where commands run on the host when the step has no workspace; the home directory when none is given. */
  readonly workDir?: string;
  readonly slots?: number;
}

export const DEFAULT_SSH_SLOTS = 1;

export const ssh = {
  /** A host reached over SSH as a runner: multiplexed connections, a health probe, and the command's `cwd` honoured on the host. */
  host(name: string, options: SshHostOptions): RunnerDef {
    const slots = options.slots ?? DEFAULT_SSH_SLOTS;
    let runner: SshRunner | undefined;
    const backend: RunnerBackend = {
      exec(command, cancel, resolver) {
        runner ??= new SshRunner(name, {
          host: options.user ? `${options.user}@${options.host}` : options.host,
          workDir: options.workDir ?? '~',
          maxConcurrentSlots: slots,
          ...(options.key ? { identityFile: resolver.env(options.key) } : {}),
        });
        return localBackend(runner).exec(command, cancel, resolver);
      },
    };
    return defineRunner(name, backend).slots(slots);
  },
};
