import type { EnvRef, PortRef, Resolver } from '../kernel/refs.js';

/** Resolves env references from the process environment and port slots from the given map. */
export function processResolver(ports: Readonly<Record<number, number>> = {}, env: NodeJS.ProcessEnv = process.env): Resolver {
  return {
    env(ref: EnvRef): string {
      const value = env[ref.name];
      if (value === undefined || value === '') throw new Error(`environment variable "${ref.name}" is not set`);
      return value;
    },
    port(ref: PortRef): number {
      const port = ports[ref.slot];
      if (port === undefined) throw new Error(`port slot ${ref.slot} is not mapped`);
      return port;
    },
  };
}
