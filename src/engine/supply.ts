import type { LaneDef, Route, Router } from '../dsl/lanes.js';
import type { State, Supplier, SupplySink } from '../kernel/index.js';
import type { Json } from '../kernel/refs.js';
import type { Runtime } from './runtime.js';

type AnyLane = LaneDef<unknown, State, unknown, string>;

const router: Router<unknown> = {
  create: (attrs) => ({ route: 'create', attrs }),
  signal: (signal, key, payload) => ({ route: 'signal', signal, key, payload }),
  skip: () => ({ route: 'skip' }),
};

export async function startSuppliers(runtime: Runtime): Promise<() => Promise<void>> {
  const stops: (() => Promise<void>)[] = [];
  for (const lane of runtime.harness.laneList as readonly AnyLane[]) {
    for (const supply of lane.supplies) {
      if (supply.supplier.entity === 'operator' || !supply.route) continue;
      const supplier = supply.supplier as Supplier<unknown>;
      const route = supply.route;
      const sink: SupplySink<unknown> = {
        emit: async (event, externalId) => {
          const routes = route(event, router);
          for (const one of Array.isArray(routes) ? (routes as readonly Route[]) : [routes as Route]) {
            if (one.route === 'create') await runtime.createUnit(lane, one.attrs, { source: `${supplier.name}:${externalId}` });
            if (one.route === 'signal') await runtime.deliverSignal(lane.name, one.key!, one.signal!.name, one.payload as Json, `${supplier.name}:${externalId}`);
          }
        },
      };
      const handle = await supplier.start(sink, runtime.resolver);
      stops.push(handle.stop);
    }
  }
  return async () => {
    for (const stop of stops) await stop();
  };
}
