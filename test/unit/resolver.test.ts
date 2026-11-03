import { describe, expect, it } from 'vitest';
import { processResolver } from '../../src/engine/resolver.js';

describe('the process resolver', () => {
  it('reads a variable whole, or one of its comma-separated values by index', () => {
    const resolver = processResolver({ 1: 4100 }, { KEYS: 'alpha, beta,gamma', ONE: 'solo', EMPTY: '' });
    expect.soft(resolver.env({ ref: 'env', name: 'KEYS' })).toBe('alpha, beta,gamma');
    expect.soft(resolver.env({ ref: 'env', name: 'KEYS', index: 1 })).toBe('beta');
    expect.soft(resolver.env({ ref: 'env', name: 'KEYS', index: 2 })).toBe('gamma');
    expect.soft(resolver.env({ ref: 'env', name: 'ONE', index: 0 })).toBe('solo');
    expect.soft(() => resolver.env({ ref: 'env', name: 'KEYS', index: 3 })).toThrow(/holds 3 value/);
    expect.soft(() => resolver.env({ ref: 'env', name: 'EMPTY' })).toThrow(/not set/);
    expect.soft(() => resolver.env({ ref: 'env', name: 'MISSING' })).toThrow(/not set/);
    expect.soft(resolver.port({ ref: 'port', slot: 1 })).toBe(4100);
    expect(() => resolver.port({ ref: 'port', slot: 2 })).toThrow(/not mapped/);
  });
});
