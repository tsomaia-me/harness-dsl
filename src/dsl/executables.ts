import type { Named } from '../kernel/refs.js';

export interface Executable<I, O> extends Named {
  readonly entity: string;
  readonly _io?: { readonly in: (input: I) => void; readonly out: O };
}

export type InputOf<E> = E extends Executable<infer I, unknown> ? I : never;
export type OutputOf<E> = E extends Executable<unknown, infer O> ? O : never;
