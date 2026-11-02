import type { FacetRef, FacetValue, ResourceRef } from '../kernel/lifecycle.js';

export interface ResourceDef extends ResourceRef {}

export function resource(name: string): ResourceDef {
  return { entity: 'resource', name };
}

export class ResourceSetDef<V extends string> {
  public readonly entity = 'resourceSet' as const;
  public readonly name: string;
  public readonly values: readonly V[];
  public readonly all: readonly ResourceDef[];

  public constructor(name: string, values: readonly V[]) {
    this.name = name;
    this.values = values;
    this.all = values.map((value) => ({ entity: 'resource', name: `${name}:${value}` }));
  }

  public of(value: V): ResourceDef {
    return { entity: 'resource', name: `${this.name}:${value}` };
  }
}

export function resources<const V extends string>(name: string, values: readonly V[]): ResourceSetDef<V> {
  return new ResourceSetDef(name, values);
}

export class FacetDef<V extends string = string> implements FacetRef {
  public readonly entity = 'facet' as const;
  public readonly name: string;
  public readonly values: readonly V[];

  public constructor(name: string, values: readonly V[]) {
    this.name = name;
    this.values = values;
  }

  public of(value: V): FacetValue<V> {
    return { facet: this, value };
  }
}

export function facet<const V extends string>(name: string, values: readonly V[]): FacetDef<V> {
  return new FacetDef(name, values);
}
