import type { MetricRef } from '../kernel/lifecycle.js';
import type { Dimensions } from '../kernel/metrics.js';
import type { Named } from '../kernel/refs.js';
import type { Source } from './sources.js';

export interface Sample extends Dimensions {
  readonly hit: boolean;
}

export interface Amount extends Dimensions {
  readonly amount: number;
}

export interface MetricDef<M extends 'rate' | 'total', E = unknown> extends MetricRef<M> {
  readonly source: Source<E>;
  readonly extract: (event: E) => readonly (Sample | Amount)[];
}

export interface AnyMetric extends MetricRef<'rate' | 'total'> {
  readonly source: Source<unknown>;
  readonly extract: (event: never) => readonly (Sample | Amount)[];
}

export class MetricDraft<E> implements Named {
  public readonly name: string;
  public readonly source: Source<E>;

  public constructor(name: string, source: Source<E>) {
    this.name = name;
    this.source = source;
  }

  public samples(extract: (event: E) => readonly Sample[]): MetricDef<'rate', E> {
    return { entity: 'metric', measure: 'rate', name: this.name, source: this.source, extract };
  }

  public amounts(extract: (event: E) => readonly Amount[]): MetricDef<'total', E> {
    return { entity: 'metric', measure: 'total', name: this.name, source: this.source, extract };
  }
}

export function metric<E>(name: string, source: Source<E>): MetricDraft<E> {
  return new MetricDraft(name, source);
}
