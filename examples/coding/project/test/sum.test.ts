import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sum } from '../src/sum.ts';

test('adds two numbers', () => {
  assert.equal(sum(1, 2), 3);
  assert.equal(sum(-1, 1), 0);
});
