import type { BatchModel, Model } from '../kernel/backends.js';
import type { SeatRef } from '../kernel/lifecycle.js';
import type { Executable } from './executables.js';
import type { Empty } from './kinds.js';
import type { ModelPolicyDef } from './policies.js';
import type { PoolDef } from './pools.js';
import type { RoleDef } from './roles.js';

export class SeatDef<I = Empty, O = Empty, D extends string = string, B extends boolean = boolean> implements Executable<I, O>, SeatRef {
  public readonly entity = 'seat' as const;
  public readonly name: string;
  public readonly roleDef: RoleDef<I, O> | undefined;
  public readonly modelChoice: Model<D> | ModelPolicyDef<D> | undefined;
  public readonly poolDef: PoolDef<D> | undefined;
  public readonly _io?: { readonly in: (input: I) => void; readonly out: O };
  public readonly _seat?: { readonly driver: D; readonly batch: B };

  public constructor(name: string, roleDef?: RoleDef<I, O>, modelChoice?: Model<D> | ModelPolicyDef<D>, poolDef?: PoolDef<D>) {
    this.name = name;
    this.roleDef = roleDef;
    this.modelChoice = modelChoice;
    this.poolDef = poolDef;
  }

  public role<I2, O2>(role: RoleDef<I2, O2>): SeatDef<I2, O2, D, B> {
    return new SeatDef<I2, O2, D, B>(this.name, role, this.modelChoice, this.poolDef);
  }

  public model<D2 extends string>(model: BatchModel<D2>): SeatDef<I, O, D2, true>;
  public model<D2 extends string>(model: Model<D2> | ModelPolicyDef<D2>): SeatDef<I, O, D2, false>;
  public model<D2 extends string>(model: Model<D2> | ModelPolicyDef<D2>): SeatDef<I, O, D2, boolean> {
    return new SeatDef<I, O, D2, boolean>(this.name, this.roleDef, model);
  }

  public pool(pool: PoolDef<D>): SeatDef<I, O, D, B> {
    return new SeatDef<I, O, D, B>(this.name, this.roleDef, this.modelChoice, pool);
  }
}

export function seat(name: string): SeatDef<Empty, Empty, string, false> {
  return new SeatDef(name);
}
