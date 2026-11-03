export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };
export type JsonObject = { readonly [key: string]: Json };

export interface Named {
  readonly name: string;
}

export interface Entity<E extends string> extends Named {
  readonly entity: E;
}

export interface EnvRef {
  readonly ref: 'env';
  readonly name: string;
  /** Which of the variable's comma-separated values, counted from 0; absent, the whole value. */
  readonly index?: number;
}

export interface PortRef {
  readonly ref: 'port';
  readonly slot: number;
}

export interface Resolver {
  env(ref: EnvRef): string;
  port(ref: PortRef): number;
}
