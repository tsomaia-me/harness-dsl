import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codingHarness } from '../../examples/coding/harness.js';
import { triageHarness } from '../../examples/triage/harness.js';
import { validate } from '../../src/dsl/index.js';

describe('the example harnesses', () => {
  let dir: string;
  let repo: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'harness-examples-'));
    repo = path.join(dir, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    writeFileSync(path.join(repo, 'README.md'), 'x\n');
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('validate', () => {
    const coding = codingHarness({ repo, stateDir: path.join(dir, 'coding') });
    const triage = triageHarness({ stateDir: path.join(dir, 'triage') });
    expect.soft(validate(coding.harness)).toEqual([]);
    expect(validate(triage.harness)).toEqual([]);
    coding.quota.close();
    for (const harness of [coding.harness, triage.harness]) harness.ledgerDef!.close();
  });

});
