import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_QUOTA_POLICY } from '../../src/quota.js';
import { HarnessStore } from '../../src/store.js';

describe('HarnessStore & Projections', () => {
  const tempDirs: string[] = [];

  function makeStore(): HarnessStore {
    const dir = mkdtempSync(path.join(tmpdir(), 'harness-store-test-'));
    tempDirs.push(dir);
    return new HarnessStore(dir);
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tracks workflow runs, updates account token usage, pauses on haltRun, resolves blockers, and projects BOARD.md and TELEMETRY.md', async () => {
    const store = makeStore();
    store.createRun({
      id: 'run-1',
      flowName: 'ticket-flow',
      ticketId: 'T-101',
      workDir: store.projectDir,
      input: { goal: 'ship' },
    });

    expect.soft(existsSync(store.boardPath)).toBe(true);
    expect.soft(readFileSync(store.boardPath, 'utf8')).toContain('T-101');

    const waitPromise = store.haltRun('run-1', 'Clarify currency rounding');
    expect.soft(store.getRun('run-1')?.status).toBe('blocked');
    const boardWhileBlocked = readFileSync(store.boardPath, 'utf8');
    expect.soft(boardWhileBlocked).toContain('BLOCKED: Clarify currency rounding');
    expect.soft(boardWhileBlocked).toContain('## Open Blockers');

    const resolved = store.resolveBlocker('run-1', { answer: 'round down' });
    expect.soft(resolved).toBe(true);
    await expect(waitPromise).resolves.toEqual({ answer: 'round down' });
    expect.soft(store.getRun('run-1')?.status).toBe('running');

    store.registerQuotaPolicy('claude-main', { ...DEFAULT_QUOTA_POLICY, tokenBudget: 5_000_000 });
    store.startInvocation({
      id: 'inv-1',
      runId: 'run-1',
      iteration: 0,
      stepName: 'build',
      actorName: 'builder',
      actorKind: 'agent',
      accountId: 'claude-main',
      modelId: 'claude-opus-4-6',
    });
    store.finishInvocation('inv-1', {
      status: 'pass',
      inputTokens: 12000,
      cachedInputTokens: 8000,
      outputTokens: 1500,
      actualCostUsd: 0,
      equivalentCostUsd: 0.42,
      output: { status: 'READY' },
    });

    const quotaAfterInv = store.getAccountQuota('claude-main');
    expect.soft(quotaAfterInv?.windowTokensUsed).toBe(13500);
    expect.soft((quotaAfterInv?.projectShareUsed ?? 0) > 0).toBe(true);

    store.updateRunProgress('run-1', { status: 'completed', finishedAtMs: Date.now() });
    expect.soft(existsSync(store.telemetryPath)).toBe(true);
    const telemetryMd = readFileSync(store.telemetryPath, 'utf8');
    expect.soft(telemetryMd).toContain('$0.4200');
    expect.soft(telemetryMd).toContain('## Per-Run Breakdown');
    expect.soft(telemetryMd).toContain('## Per-Agent Scorecard');
    store.close();
  });

  it('renders one BOARD.md column per quota window id with usage and reset countdown', () => {
    const store = makeStore();
    store.upsertAccountQuota('acct-1', {
      windows: [{ id: 'acme:weekly', utilization: 0.42, resetsAtMs: Date.now() + 2 * 3600_000 + 30 * 60_000 }],
    });
    store.upsertAccountQuota('acct-2', { windows: [{ id: 'acme:rpm', utilization: 0.07 }] });

    const board = readFileSync(store.boardPath, 'utf8');
    expect.soft(board).toContain('| Account | acme:rpm | acme:weekly | Project Share | Status |');
    expect.soft(board).toContain('| `acct-1` | — | 42% (2h 30m) | 0% | READY |');
    expect.soft(board).toContain('| `acct-2` | 7% | — | 0% | READY |');
    store.close();
  });

  it('backs up a runtime.db written by an older schema and starts a fresh one', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harness-store-test-'));
    tempDirs.push(dir);
    mkdirSync(path.join(dir, '.harness'));
    const legacy = new Database(path.join(dir, '.harness', 'runtime.db'));
    legacy.exec(
      'CREATE TABLE account_quotas (account_id TEXT PRIMARY KEY, utilization_5h REAL, updated_at_ms INTEGER NOT NULL);',
    );
    legacy.prepare('INSERT INTO account_quotas VALUES (?, ?, ?)').run('legacy-acct', 0.5, 1);
    legacy.close();

    const store = new HarnessStore(dir);
    store.upsertAccountQuota('acct-new', { windows: [{ id: 'acme:rpm', utilization: 0.3 }] });

    expect.soft(store.getAccountQuota('acct-new')?.windows).toEqual([
      { id: 'acme:rpm', utilization: 0.3, resetsAtMs: null },
    ]);
    expect.soft(store.getAccountQuota('legacy-acct')).toBeNull();
    const backup = new Database(path.join(dir, '.harness', 'runtime.db.v0.bak'), { readonly: true });
    expect.soft(backup.prepare('SELECT account_id FROM account_quotas').all()).toEqual([
      { account_id: 'legacy-acct' },
    ]);
    backup.close();
    store.close();
  });

  it('enforces exclusive file leases across concurrent runs and releases them cleanly', () => {
    const store = makeStore();
    const first = store.acquireFileLease('run-a', 'apps/admin/src/modules/items/**');
    expect.soft(first.ok).toBe(true);

    const conflicting = store.acquireFileLease('run-b', 'apps/admin/src/modules/items/ItemsPage.tsx');
    expect.soft(conflicting).toEqual({ ok: false, holderRunId: 'run-a' });

    const disjoint = store.acquireFileLease('run-b', 'apps/edge/src/wallet/ledger.ts');
    expect.soft(disjoint.ok).toBe(true);

    store.releaseRunLeases('run-a');
    const afterRelease = store.acquireFileLease('run-b', 'apps/admin/src/modules/items/ItemsPage.tsx');
    expect.soft(afterRelease.ok).toBe(true);
    store.close();
  });

  it('manages lessons.jsonl, deduplicates similar rules on addLesson, and filters by role and picomatch file globs', () => {
    const store = makeStore();
    const l1 = store.addLesson({
      kind: 'domain',
      roles: ['builder'],
      paths: ['apps/admin/**'],
      rule: 'Use onChange on controlled Mantine Popovers, because onClose never fires.',
    });
    const l2 = store.addLesson({
      kind: 'behavioral',
      roles: ['builder', 'auditor'],
      paths: ['**'],
      rule: 'Write a refusal test for every guarded route, because happy paths stay green when guards are deleted.',
    });

    expect.soft(l1.id).toBe('L-1');
    expect.soft(l2.id).toBe('L-2');

    const dup = store.addLesson({
      kind: 'domain',
      roles: ['auditor'],
      paths: ['apps/web/**'],
      rule: 'Use onChange on controlled Mantine Popovers because onClose never fires in tests.',
    });
    expect.soft(dup.id).toBe('L-1');
    expect.soft(dup.roles).toEqual(['builder', 'auditor']);
    expect.soft(dup.paths).toEqual(['apps/admin/**', 'apps/web/**']);

    const edgeBuilderLessons = store.filterLessons('builder', ['apps/edge/src/api.ts']);
    expect.soft(edgeBuilderLessons.map((l) => l.id)).toEqual(['L-2']);

    const adminBuilderLessons = store.filterLessons('builder', ['apps/admin/src/App.tsx']);
    expect.soft(adminBuilderLessons.map((l) => l.id)).toEqual(['L-1', 'L-2']);

    const widened = store.widenLesson('L-1', {
      roles: ['builder', 'auditor'],
      rule: 'Use onChange on controlled Mantine Popovers and Modals, because onClose never fires.',
    });
    expect.soft(widened.roles).toEqual(['builder', 'auditor']);

    expect.soft(store.removeLesson('L-1')).toBe(true);
    expect.soft(store.listLessons().map((l) => l.id)).toEqual(['L-2']);
    store.close();
  });
});
