export { z } from 'zod';
export * from './dsl/index.js';
export { ControlError } from './engine/control.js';
export { processResolver } from './engine/resolver.js';
export { Runtime, StartupError, type RuntimeOptions } from './engine/runtime.js';
import type { HarnessDef } from './dsl/harness.js';
import { Runtime, type RuntimeOptions } from './engine/runtime.js';

/** Validates the harness, starts its runtime and returns it; `runtime.run()` then ticks until `stop()`. */
export async function start(harness: HarnessDef, options: Omit<RuntimeOptions, 'harness'>): Promise<Runtime> {
  const runtime = new Runtime({ harness, ...options });
  await runtime.start();
  return runtime;
}
