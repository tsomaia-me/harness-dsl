import type { HaltRef, SignalRef } from '../kernel/lifecycle.js';
import type { Empty, Schema } from './kinds.js';

export class HaltDef<N extends string = string, D = Empty> implements HaltRef {
  public readonly entity = 'halt' as const;
  public readonly name: N;
  public readonly decisionSchema: Schema<D> | undefined;
  public readonly _decision?: D;

  public constructor(name: N, decisionSchema?: Schema<D>) {
    this.name = name;
    this.decisionSchema = decisionSchema;
  }

  public decision<D2>(schema: Schema<D2>): HaltDef<N, D2> {
    return new HaltDef<N, D2>(this.name, schema);
  }
}

export function halt<N extends string>(name: N): HaltDef<N, Empty> {
  return new HaltDef(name);
}

export class SignalDef<N extends string = string, P = Empty> implements SignalRef {
  public readonly entity = 'signal' as const;
  public readonly name: N;
  public readonly payloadSchema: Schema<P> | undefined;
  public readonly _payload?: P;

  public constructor(name: N, payloadSchema?: Schema<P>) {
    this.name = name;
    this.payloadSchema = payloadSchema;
  }

  public payload<P2>(schema: Schema<P2>): SignalDef<N, P2> {
    return new SignalDef<N, P2>(this.name, schema);
  }
}

export function signal<N extends string>(name: N): SignalDef<N, Empty> {
  return new SignalDef(name);
}

export const cancel: SignalDef<'cancel', { readonly reason?: string }> = new SignalDef('cancel');
