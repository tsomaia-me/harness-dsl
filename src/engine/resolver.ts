import type { EnvRef, PortRef, Resolver } from '../kernel/refs.js';

/** Resolves env references from the process environment and port slots from the given map. */
export function processResolver(ports: Readonly<Record<number, number>> = {}, env: NodeJS.ProcessEnv = process.env): Resolver {
  return {
    env(ref: EnvRef): string {
      const value = env[ref.name];
      if (value === undefined || value === '') throw new Error(`environment variable "${ref.name}" is not set`);
      if (ref.index === undefined) return value;
      const values = value.split(',').map((part) => part.trim());
      const picked = values[ref.index];
      if (picked === undefined || picked === '') throw new Error(`environment variable "${ref.name}" holds ${values.length} value(s); there is no value ${ref.index}`);
      return picked;
    },
    port(ref: PortRef): number {
      const port = ports[ref.slot];
      if (port === undefined) throw new Error(`port slot ${ref.slot} is not mapped`);
      return port;
    },
  };
}
