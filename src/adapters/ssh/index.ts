import { defineRunner, type RunnerDef } from '../../dsl/runners.js';
import { localBackend } from '../local/index.js';
import { SshRunner, type SshRunnerOptions } from '../../runner.js';

export const ssh = {
  /** A host reached over SSH as a runner: the 0.3.0 SSH runner with its multiplexing, health probe and slots. */
  host(name: string, options: SshRunnerOptions): RunnerDef {
    return defineRunner(name, localBackend(new SshRunner(name, options))).slots(options.maxConcurrentSlots ?? 1);
  },
};
