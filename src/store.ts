import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import matter from 'gray-matter';
import picomatch from 'picomatch';
import { z } from 'zod';
import {
  accountQuotas,
  accountQuotaWindows,
  BOOTSTRAP_SQL,
  fileLeases,
  headSessions,
  invocations,
  SCHEMA_VERSION,
  workflowRuns,
} from './schema.js';
import type { LessonEntry, QuotaPatch, QuotaPolicy, QuotaWindow } from './types.js';

export const LessonSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['domain', 'behavioral']),
  roles: z.array(z.string()).min(1),
  paths: z.array(z.string()).min(1),
  rule: z.string().min(1),
  createdAt: z.string().min(1),
});

export interface CreateRunInput {
  readonly id: string;
  readonly flowName: string;
  readonly ticketId?: string;
  readonly workDir: string;
  readonly input: unknown;
}

export interface StartInvocationInput {
  readonly id: string;
  readonly runId: string;
  readonly iteration: number;
  readonly stepName: string;
  readonly actorName: string;
  readonly actorKind: 'agent' | 'command' | 'batch';
  readonly accountId?: string;
  readonly modelId?: string;
  readonly runnerId?: string;
  readonly sessionId?: string;
}

export interface FinishInvocationInput {
  readonly status: 'pass' | 'fail' | 'blocked' | 'timeout';
  readonly sessionId?: string;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly actualCostUsd?: number | null;
  readonly equivalentCostUsd?: number | null;
  readonly output?: unknown;
  readonly errorText?: string;
}

export interface AccountQuotaState {
  readonly accountId: string;
  readonly windows: readonly QuotaWindow[];
  readonly projectShareUsed: number;
  readonly windowTokensUsed: number;
  readonly cooldownUntilMs: number | null;
  readonly probedAtMs: number | null;
  readonly acquiredAtMs: number | null;
}

export interface AccountQuotaPatch extends QuotaPatch {
  readonly projectShareUsed?: number;
  readonly windowTokensUsed?: number;
  readonly probedAtMs?: number | null;
  readonly acquiredAtMs?: number | null;
}

function definedEntries<T extends Record<string, unknown>>(record: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

export interface TicketRecord {
  readonly id: string;
  readonly frontmatter: Record<string, unknown>;
  readonly content: string;
  readonly filePath: string;
}

function normalizeRuleTokens(rule: string): Set<string> {
  const words = rule
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);
  return new Set(words);
}

function areRulesSimilar(a: string, b: string): boolean {
  const normA = a.trim().toLowerCase().replace(/\s+/g, ' ');
  const normB = b.trim().toLowerCase().replace(/\s+/g, ' ');
  if (normA === normB || normA.includes(normB) || normB.includes(normA)) {
    return true;
  }
  const setA = normalizeRuleTokens(a);
  const setB = normalizeRuleTokens(b);
  if (setA.size === 0 || setB.size === 0) return false;
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 && intersection / union >= 0.7;
}

export function sumCosts(costs: readonly (number | null)[]): {
  readonly usd: number;
  readonly unpriced: number;
} {
  return {
    usd: costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0),
    unpriced: costs.filter((cost) => cost === null).length,
  };
}

function formatCosts(costs: readonly (number | null)[]): string {
  const { usd, unpriced } = sumCosts(costs);
  if (costs.length > 0 && unpriced === costs.length) return '—';
  return unpriced > 0 ? `$${usd.toFixed(4)} + unpriced` : `$${usd.toFixed(4)}`;
}

function formatCountdown(targetMs: number | null, nowMs: number): string {
  if (!targetMs || targetMs <= nowMs) return '—';
  const diffMin = Math.ceil((targetMs - nowMs) / 60_000);
  if (diffMin < 60) return `${diffMin}m`;
  const hours = Math.floor(diffMin / 60);
  const mins = diffMin % 60;
  return `${hours}h${mins > 0 ? ` ${mins}m` : ''}`;
}

export class HarnessStore {
  public readonly projectDir: string;
  public readonly harnessDir: string;
  public readonly ticketsDir: string;
  public readonly dbPath: string;
  public readonly lessonsPath: string;
  public readonly boardPath: string;
  public readonly telemetryPath: string;
  private readonly sqlite: Database.Database;
  public readonly db: BetterSQLite3Database;
  private readonly blockerWaiters = new Map<string, (resolution: unknown) => void>();
  private readonly accountShareOverrides = new Map<string, number>();
  private readonly quotaPolicies = new Map<string, QuotaPolicy>();
  private readonly runContextTokens = new Map<string, number>();

  public constructor(projectDir: string) {
    this.projectDir = path.resolve(projectDir);
    this.harnessDir = path.join(this.projectDir, '.harness');
    this.ticketsDir = path.join(this.harnessDir, 'tickets');
    mkdirSync(this.harnessDir, { recursive: true });
    this.dbPath = path.join(this.harnessDir, 'runtime.db');
    this.lessonsPath = path.join(this.harnessDir, 'lessons.jsonl');
    this.boardPath = path.join(this.harnessDir, 'BOARD.md');
    this.telemetryPath = path.join(this.harnessDir, 'TELEMETRY.md');

    this.sqlite = this.openCurrentSchemaDatabase();
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('busy_timeout = 5000');
    this.sqlite.exec(BOOTSTRAP_SQL);
    this.sqlite.pragma(`user_version = ${SCHEMA_VERSION}`);
    this.db = drizzle(this.sqlite);
  }

  private openCurrentSchemaDatabase(): Database.Database {
    const existing = new Database(this.dbPath);
    const version = Number(existing.pragma('user_version', { simple: true }));
    const { tableCount } = existing
      .prepare("SELECT count(*) AS tableCount FROM sqlite_master WHERE type = 'table'")
      .get() as { tableCount: number };
    if (version === SCHEMA_VERSION || tableCount === 0) {
      return existing;
    }
    existing.pragma('wal_checkpoint(TRUNCATE)');
    existing.close();
    const backupPath = `${this.dbPath}.v${version}.bak`;
    renameSync(this.dbPath, existsSync(backupPath) ? `${backupPath}.${Date.now()}` : backupPath);
    rmSync(`${this.dbPath}-wal`, { force: true });
    rmSync(`${this.dbPath}-shm`, { force: true });
    return new Database(this.dbPath);
  }

  public close(): void {
    this.sqlite.close();
  }

  public setRunContextTokens(runId: string, tokens: number): void {
    this.runContextTokens.set(runId, tokens);
    this.projectBoard();
  }

  public getRunContextTokens(runId: string): number {
    return this.runContextTokens.get(runId) ?? 0;
  }

  public setAccountShareOverride(accountId: string, share: number): void {
    if (share <= 0 || share > 1) {
      throw new Error(`Invalid quota share ${share}`);
    }
    this.accountShareOverrides.set(accountId, share);
    this.projectBoard();
  }

  public getAccountShareOverride(accountId: string): number | undefined {
    return this.accountShareOverrides.get(accountId);
  }

  public registerQuotaPolicy(accountId: string, policy: QuotaPolicy): void {
    this.quotaPolicies.set(accountId, policy);
  }

  public createRun(input: CreateRunInput): void {
    const now = Date.now();
    this.db
      .insert(workflowRuns)
      .values({
        id: input.id,
        flowName: input.flowName,
        ticketId: input.ticketId ?? null,
        status: 'running',
        iteration: 0,
        currentStep: null,
        workDir: input.workDir,
        inputJson: JSON.stringify(input.input ?? null),
        stateJson: JSON.stringify({}),
        blockerReason: null,
        blockerResolutionJson: null,
        startedAtMs: now,
        finishedAtMs: null,
      })
      .run();
    this.projectBoard();
  }

  public updateRunProgress(
    runId: string,
    patch: {
      status?: 'queued' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';
      iteration?: number;
      currentStep?: string | null;
      state?: unknown;
      finishedAtMs?: number | null;
    },
  ): void {
    const updates: Record<string, unknown> = {};
    if (patch.status !== undefined) updates.status = patch.status;
    if (patch.iteration !== undefined) updates.iteration = patch.iteration;
    if (patch.currentStep !== undefined) updates.currentStep = patch.currentStep;
    if (patch.state !== undefined) updates.stateJson = JSON.stringify(patch.state);
    if (patch.finishedAtMs !== undefined) updates.finishedAtMs = patch.finishedAtMs;

    this.db.update(workflowRuns).set(updates).where(eq(workflowRuns.id, runId)).run();
    this.projectBoard();
    if (
      patch.status === 'completed' ||
      patch.status === 'failed' ||
      patch.status === 'cancelled'
    ) {
      this.projectTelemetry();
    }
  }

  public getRun(runId: string) {
    return this.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get() ?? null;
  }

  public listRuns() {
    return this.db.select().from(workflowRuns).all();
  }

  public haltRun(runId: string, reason: string): Promise<unknown> {
    this.db
      .update(workflowRuns)
      .set({ status: 'blocked', blockerReason: reason })
      .where(eq(workflowRuns.id, runId))
      .run();
    this.projectBoard();
    return new Promise((resolve) => {
      this.blockerWaiters.set(runId, resolve);
    });
  }

  public resolveBlocker(runId: string, resolution: unknown): boolean {
    const run = this.getRun(runId);
    if (!run || run.status !== 'blocked') return false;
    this.db
      .update(workflowRuns)
      .set({
        status: 'running',
        blockerReason: null,
        blockerResolutionJson: JSON.stringify(resolution),
      })
      .where(eq(workflowRuns.id, runId))
      .run();
    this.projectBoard();
    const waiter = this.blockerWaiters.get(runId);
    if (waiter) {
      this.blockerWaiters.delete(runId);
      waiter(resolution);
    }
    return true;
  }

  public startInvocation(input: StartInvocationInput): void {
    this.db
      .insert(invocations)
      .values({
        id: input.id,
        runId: input.runId,
        iteration: input.iteration,
        stepName: input.stepName,
        actorName: input.actorName,
        actorKind: input.actorKind,
        accountId: input.accountId ?? null,
        modelId: input.modelId ?? null,
        runnerId: input.runnerId ?? null,
        sessionId: input.sessionId ?? null,
        startedAtMs: Date.now(),
        status: 'running',
      })
      .run();
  }

  public finishInvocation(invocationId: string, input: FinishInvocationInput): void {
    const existing = this.db
      .select()
      .from(invocations)
      .where(eq(invocations.id, invocationId))
      .get();
    const now = Date.now();
    const durationMs = existing ? Math.max(0, now - existing.startedAtMs) : 0;
    const inTokens = input.inputTokens ?? 0;
    const cacheTokens = input.cachedInputTokens ?? 0;
    const outTokens = input.outputTokens ?? 0;

    this.db
      .update(invocations)
      .set({
        status: input.status,
        sessionId: input.sessionId ?? existing?.sessionId ?? null,
        finishedAtMs: now,
        durationMs,
        inputTokens: inTokens,
        cachedInputTokens: cacheTokens,
        outputTokens: outTokens,
        actualCostUsd: input.actualCostUsd === undefined ? 0 : input.actualCostUsd,
        equivalentCostUsd: input.equivalentCostUsd === undefined ? 0 : input.equivalentCostUsd,
        outputJson: input.output !== undefined ? JSON.stringify(input.output) : null,
        errorText: input.errorText ?? null,
      })
      .where(eq(invocations.id, invocationId))
      .run();

    if (existing?.accountId && (inTokens > 0 || outTokens > 0)) {
      this.recordAccountTokenUsage(existing.accountId, inTokens + outTokens);
    }

    this.projectTelemetry();
  }

  public recordAccountTokenUsage(accountId: string, tokensDelta: number): void {
    const tokens = Math.max(0, tokensDelta);
    const existing = this.getAccountQuota(accountId);
    const tokenBudget = this.quotaPolicies.get(accountId)?.tokenBudget ?? null;
    this.upsertAccountQuota(accountId, {
      windowTokensUsed: (existing?.windowTokensUsed ?? 0) + tokens,
      projectShareUsed:
        tokenBudget === null
          ? undefined
          : Math.min(1, (existing?.projectShareUsed ?? 0) + tokens / tokenBudget),
    });
  }

  public listInvocations(runId?: string) {
    if (runId) {
      return this.db.select().from(invocations).where(eq(invocations.runId, runId)).all();
    }
    return this.db.select().from(invocations).all();
  }

  public getAccountQuota(accountId: string): AccountQuotaState | null {
    const row = this.db
      .select()
      .from(accountQuotas)
      .where(eq(accountQuotas.accountId, accountId))
      .get();
    return row ? { ...row, windows: this.listQuotaWindows(accountId) } : null;
  }

  public listAccountQuotas(): AccountQuotaState[] {
    return this.db
      .select()
      .from(accountQuotas)
      .all()
      .map((row) => ({ ...row, windows: this.listQuotaWindows(row.accountId) }));
  }

  private listQuotaWindows(accountId: string): QuotaWindow[] {
    return this.db
      .select()
      .from(accountQuotaWindows)
      .where(eq(accountQuotaWindows.accountId, accountId))
      .orderBy(accountQuotaWindows.windowId)
      .all()
      .map((row) => ({ id: row.windowId, utilization: row.utilization, resetsAtMs: row.resetsAtMs }));
  }

  public upsertAccountQuota(accountId: string, patch: AccountQuotaPatch): void {
    const { windows, ...accountFields } = patch;
    const fields = definedEntries(accountFields);
    this.sqlite.transaction(() => {
      const insertAccount = this.db.insert(accountQuotas).values({ accountId, ...fields });
      if (Object.keys(fields).length > 0) {
        insertAccount.onConflictDoUpdate({ target: accountQuotas.accountId, set: fields }).run();
      } else {
        insertAccount.onConflictDoNothing().run();
      }
      for (const window of windows ?? []) {
        const windowFields = definedEntries({
          utilization: window.utilization,
          resetsAtMs: window.resetsAtMs,
        });
        const insertWindow = this.db
          .insert(accountQuotaWindows)
          .values({ accountId, windowId: window.id, ...windowFields });
        if (Object.keys(windowFields).length > 0) {
          insertWindow
            .onConflictDoUpdate({
              target: [accountQuotaWindows.accountId, accountQuotaWindows.windowId],
              set: windowFields,
            })
            .run();
        } else {
          insertWindow.onConflictDoNothing().run();
        }
      }
    })();
    this.projectBoard();
  }

  public acquireFileLease(
    runId: string,
    filePathOrPattern: string,
  ): { ok: boolean; holderRunId?: string } {
    const normalized = filePathOrPattern.replace(/\\/g, '/');
    const allLeases = this.db.select().from(fileLeases).all();
    for (const lease of allLeases) {
      if (lease.runId === runId) continue;
      const matchesExisting =
        lease.pattern === normalized ||
        picomatch.isMatch(normalized, lease.pattern) ||
        picomatch.isMatch(lease.pattern, normalized);
      if (matchesExisting) {
        return { ok: false, holderRunId: lease.runId };
      }
    }
    const existingOwn = allLeases.find((l) => l.pattern === normalized && l.runId === runId);
    if (!existingOwn) {
      this.db
        .insert(fileLeases)
        .values({
          pattern: normalized,
          runId,
          acquiredAtMs: Date.now(),
        })
        .run();
    }
    return { ok: true };
  }

  public releaseRunLeases(runId: string): void {
    this.db.delete(fileLeases).where(eq(fileLeases.runId, runId)).run();
  }

  public listFileLeases() {
    return this.db.select().from(fileLeases).all();
  }

  public upsertHeadSession(input: {
    sessionId: string;
    transcriptPath?: string;
    contextTokens?: number;
    handoffNote?: string;
  }): void {
    const existing = this.db
      .select()
      .from(headSessions)
      .where(eq(headSessions.id, 'active'))
      .get();
    const now = Date.now();
    if (!existing) {
      this.db
        .insert(headSessions)
        .values({
          id: 'active',
          sessionId: input.sessionId,
          transcriptPath: input.transcriptPath ?? null,
          contextTokens: input.contextTokens ?? 0,
          handoffNote: input.handoffNote ?? null,
          updatedAtMs: now,
        })
        .run();
    } else {
      this.db
        .update(headSessions)
        .set({
          sessionId: input.sessionId,
          transcriptPath:
            input.transcriptPath !== undefined ? input.transcriptPath : existing.transcriptPath,
          contextTokens:
            input.contextTokens !== undefined ? input.contextTokens : existing.contextTokens,
          handoffNote: input.handoffNote !== undefined ? input.handoffNote : existing.handoffNote,
          updatedAtMs: now,
        })
        .where(eq(headSessions.id, 'active'))
        .run();
    }
  }

  public getActiveHeadSession() {
    return this.db.select().from(headSessions).where(eq(headSessions.id, 'active')).get() ?? null;
  }

  public listTickets(): TicketRecord[] {
    if (!existsSync(this.ticketsDir)) return [];
    const files = readdirSync(this.ticketsDir).filter((f) => f.endsWith('.md'));
    return files.map((file) => {
      const id = file.slice(0, -3);
      return this.readTicket(id)!;
    });
  }

  public readTicket(id: string): TicketRecord | null {
    const filePath = path.join(this.ticketsDir, `${id}.md`);
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf8');
    const parsed = matter(raw);
    return {
      id,
      frontmatter: parsed.data as Record<string, unknown>,
      content: parsed.content.trim(),
      filePath,
    };
  }

  public writeTicket(
    id: string,
    frontmatter: Record<string, unknown>,
    content: string,
  ): TicketRecord {
    mkdirSync(this.ticketsDir, { recursive: true });
    const filePath = path.join(this.ticketsDir, `${id}.md`);
    const formatted = matter.stringify(content.endsWith('\n') ? content : `${content}\n`, frontmatter);
    writeFileSync(filePath, formatted, 'utf8');
    return {
      id,
      frontmatter,
      content: content.trim(),
      filePath,
    };
  }

  public listLessons(): LessonEntry[] {
    if (!existsSync(this.lessonsPath)) return [];
    const raw = readFileSync(this.lessonsPath, 'utf8').trim();
    if (!raw) return [];
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => LessonSchema.parse(JSON.parse(line)));
  }

  public addLesson(entry: Omit<LessonEntry, 'id' | 'createdAt'> & { id?: string }): LessonEntry {
    const current = this.listLessons();
    const duplicateIdx = current.findIndex(
      (existing) => existing.kind === entry.kind && areRulesSimilar(existing.rule, entry.rule),
    );

    if (duplicateIdx !== -1 && !entry.id) {
      const existing = current[duplicateIdx]!;
      const mergedRoles = Array.from(new Set([...existing.roles, ...entry.roles]));
      const mergedPaths = Array.from(new Set([...existing.paths, ...entry.paths]));
      const mergedRule = entry.rule.length > existing.rule.length ? entry.rule : existing.rule;
      const merged: LessonEntry = LessonSchema.parse({
        ...existing,
        roles: mergedRoles,
        paths: mergedPaths,
        rule: mergedRule,
      });
      current[duplicateIdx] = merged;
      this.writeLessons(current);
      return merged;
    }

    const nextNum =
      current.reduce((max, item) => {
        const match = /^L-(\d+)$/.exec(item.id);
        return match ? Math.max(max, Number(match[1])) : max;
      }, 0) + 1;
    const record: LessonEntry = LessonSchema.parse({
      id: entry.id ?? `L-${nextNum}`,
      kind: entry.kind,
      roles: [...entry.roles],
      paths: [...entry.paths],
      rule: entry.rule,
      createdAt: new Date().toISOString().slice(0, 10),
    });
    const updated = [...current, record];
    this.writeLessons(updated);
    return record;
  }

  public widenLesson(
    id: string,
    patch: Partial<Omit<LessonEntry, 'id' | 'createdAt'>>,
  ): LessonEntry {
    const current = this.listLessons();
    const index = current.findIndex((item) => item.id === id);
    if (index === -1) {
      throw new Error(`Lesson ${id} not found`);
    }
    const existing = current[index]!;
    const updatedItem: LessonEntry = LessonSchema.parse({
      ...existing,
      kind: patch.kind ?? existing.kind,
      roles: patch.roles ? [...patch.roles] : existing.roles,
      paths: patch.paths ? [...patch.paths] : existing.paths,
      rule: patch.rule ?? existing.rule,
    });
    current[index] = updatedItem;
    this.writeLessons(current);
    return updatedItem;
  }

  public removeLesson(id: string): boolean {
    const current = this.listLessons();
    const filtered = current.filter((item) => item.id !== id);
    if (filtered.length === current.length) return false;
    this.writeLessons(filtered);
    return true;
  }

  public filterLessons(role: string, touchedPaths: readonly string[] = []): LessonEntry[] {
    const all = this.listLessons();
    return all.filter((lesson) => {
      const roleMatch = lesson.roles.includes('*') || lesson.roles.includes(role);
      if (!roleMatch) return false;
      if (lesson.paths.includes('**') || lesson.paths.includes('*') || touchedPaths.length === 0) {
        return true;
      }
      return touchedPaths.some((filePath) =>
        lesson.paths.some((pattern) => picomatch.isMatch(filePath.replace(/\\/g, '/'), pattern)),
      );
    });
  }

  private writeLessons(entries: readonly LessonEntry[]): void {
    const content = entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
    writeFileSync(this.lessonsPath, content, 'utf8');
  }

  public projectBoard(): void {
    const nowMs = Date.now();
    const quotas = this.listAccountQuotas();
    const runs = this.listRuns();
    const blockedRuns = runs.filter((r) => r.status === 'blocked');

    const windowIds = [...new Set(quotas.flatMap((q) => q.windows.map((w) => w.id)))].sort();
    const quotaColumns = ['Account', ...windowIds, 'Project Share', 'Status'];
    const quotaRows =
      quotas.length === 0
        ? `| _none_ |${' — |'.repeat(quotaColumns.length - 1)}\n`
        : quotas
            .map((q) => {
              const windowCells = windowIds.map((id) => {
                const window = q.windows.find((w) => w.id === id);
                if (!window) return '—';
                const countdown = formatCountdown(window.resetsAtMs, nowMs);
                const usage = `${Math.round(window.utilization * 100)}%`;
                return countdown === '—' ? usage : `${usage} (${countdown})`;
              });
              const share = `${Math.round(q.projectShareUsed * 100)}%`;
              const status =
                q.cooldownUntilMs && q.cooldownUntilMs > nowMs ? 'COOLDOWN' : 'READY';
              return `| ${[`\`${q.accountId}\``, ...windowCells, share, status].join(' | ')} |`;
            })
            .join('\n') + '\n';

    const runRows =
      runs.length === 0
        ? '| _none_ | — | — | — | — | — | — |\n'
        : runs
            .map((r) => {
              const detail = r.blockerReason
                ? `BLOCKED: ${r.blockerReason}`
                : (r.currentStep ?? '—');
              const ctxTok = this.getRunContextTokens(r.id);
              return `| \`${r.id}\` | \`${r.flowName}\` | \`${r.ticketId ?? '—'}\` | \`${r.status.toUpperCase()}\` | ${r.iteration} | ${ctxTok} | ${detail} |`;
            })
            .join('\n') + '\n';

    const blockerRows =
      blockedRuns.length === 0
        ? '_No open blockers._\n'
        : blockedRuns
            .map((b) => `- **\`${b.id}\`** (\`${b.flowName}\`): ${b.blockerReason ?? 'Blocked'}`)
            .join('\n') + '\n';

    const md = [
      '# Harness Board',
      '',
      '## Account Pool',
      `| ${quotaColumns.join(' | ')} |`,
      `|${' :--- |'.repeat(quotaColumns.length)}`,
      quotaRows.trimEnd(),
      '',
      '## Workflow Runs',
      '| Run ID | Flow | Ticket | Status | Iteration | Context Tokens | Detail |',
      '| :--- | :--- | :--- | :--- | :--- | :--- | :--- |',
      runRows.trimEnd(),
      '',
      '## Open Blockers',
      blockerRows.trimEnd(),
      '',
    ].join('\n');

    writeFileSync(this.boardPath, md, 'utf8');
  }

  public projectTelemetry(): void {
    const allRuns = this.listRuns();
    const allInvocations = this.listInvocations();
    const totalActual = formatCosts(allInvocations.map((i) => i.actualCostUsd));
    const totalEquiv = formatCosts(allInvocations.map((i) => i.equivalentCostUsd));
    const totalInput = allInvocations.reduce((sum, i) => sum + i.inputTokens, 0);
    const totalOutput = allInvocations.reduce((sum, i) => sum + i.outputTokens, 0);

    const runRows =
      allRuns.length === 0
        ? '| _none_ | — | — | — | — | — | — | — |\n'
        : allRuns
            .map((r) => {
              const rInvs = allInvocations.filter((i) => i.runId === r.id);
              const inTok = rInvs.reduce((s, i) => s + i.inputTokens, 0);
              const cacheTok = rInvs.reduce((s, i) => s + i.cachedInputTokens, 0);
              const outTok = rInvs.reduce((s, i) => s + i.outputTokens, 0);
              const actUsd = formatCosts(rInvs.map((i) => i.actualCostUsd));
              const eqUsd = formatCosts(rInvs.map((i) => i.equivalentCostUsd));
              const startIso = new Date(r.startedAtMs).toISOString();
              const endIso = r.finishedAtMs ? new Date(r.finishedAtMs).toISOString() : '—';
              const wallMs = r.finishedAtMs ? Math.max(0, r.finishedAtMs - r.startedAtMs) : 0;
              return `| \`${r.id}\` | \`${r.flowName}\` | ${startIso} | ${endIso} | ${wallMs}ms | ${r.iteration + 1} | ${inTok}/${cacheTok}/${outTok} | ${actUsd} (${eqUsd}) |`;
            })
            .join('\n') + '\n';

    const actorNames = Array.from(new Set(allInvocations.map((i) => i.actorName)));
    const agentScoreRows =
      actorNames.length === 0
        ? '| _none_ | — | — | — | — | — |\n'
        : actorNames
            .map((actor) => {
              const aInvs = allInvocations.filter((i) => i.actorName === actor);
              const total = aInvs.length;
              const passed = aInvs.filter((i) => i.status === 'pass').length;
              const round0 = aInvs.filter((i) => i.iteration === 0);
              const round0Pass = round0.filter((i) => i.status === 'pass').length;
              const firstRoundRate =
                round0.length > 0 ? `${Math.round((round0Pass / round0.length) * 100)}%` : '—';
              const passRate = total > 0 ? `${Math.round((passed / total) * 100)}%` : '—';
              const avgDur =
                total > 0
                  ? `${Math.round(aInvs.reduce((s, i) => s + (i.durationMs ?? 0), 0) / total)}ms`
                  : '0ms';
              const avgTokens =
                total > 0
                  ? Math.round(
                      aInvs.reduce((s, i) => s + i.inputTokens + i.outputTokens, 0) / total,
                    )
                  : 0;
              return `| \`${actor}\` | ${total} | ${firstRoundRate} | ${passRate} | ${avgDur} | ${avgTokens} tok/call |`;
            })
            .join('\n') + '\n';

    const invRows =
      allInvocations.length === 0
        ? '| _none_ | — | — | — | — | — | — | — | — |\n'
        : allInvocations
            .map((inv) => {
              const tok = `${inv.inputTokens}/${inv.cachedInputTokens}/${inv.outputTokens}`;
              return `| \`${inv.runId}\` | ${inv.iteration} | \`${inv.stepName}\` | \`${inv.actorName}\` | \`${inv.accountId ?? inv.runnerId ?? '—'}\` | ${inv.durationMs ?? 0}ms | ${tok} | ${formatCosts([inv.actualCostUsd])} (${formatCosts([inv.equivalentCostUsd])}) | \`${inv.status}\` |`;
            })
            .join('\n') + '\n';

    const md = [
      '# Harness Telemetry',
      '',
      `- Total Input Tokens: ${totalInput}`,
      `- Total Output Tokens: ${totalOutput}`,
      `- Total Actual API Cost: ${totalActual}`,
      `- Total Subscription-Equivalent Value: ${totalEquiv}`,
      '',
      '## Per-Run Breakdown',
      '| Run ID | Flow | Started | Finished | Duration | Iterations | Tokens (in/cache/out) | Cost (Actual / Equiv) |',
      '| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |',
      runRows.trimEnd(),
      '',
      '## Per-Agent Scorecard',
      '| Actor | Invocations | First-Round Pass Rate | Overall Pass Rate | Avg Duration | Token Efficiency |',
      '| :--- | :--- | :--- | :--- | :--- | :--- |',
      agentScoreRows.trimEnd(),
      '',
      '## Invocations',
      '| Run ID | Iter | Step | Actor | Target | Duration | Tokens (in/cache/out) | Cost (Actual / Equiv) | Status |',
      '| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |',
      invRows.trimEnd(),
      '',
    ].join('\n');

    writeFileSync(this.telemetryPath, md, 'utf8');
  }
}
