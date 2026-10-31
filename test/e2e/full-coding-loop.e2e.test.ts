import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { H, startOrchestrator, z } from '../../src/index.js';
import { gitWorktreeIsolation, stopCommandHook } from '../../src/plugins/index.js';

const hasClaudeCliCreds = Boolean(
  process.env.CLAUDE_CONFIG_DIR_1 ||
    process.env.CLAUDE_CODE_OAUTH_TOKEN ||
    process.env.ANTHROPIC_API_KEY,
);

describe('Live E2E 3: Full Coding Loop (Builder -> Stop Hook -> Dispute Arbiter -> Auditor -> Merge)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasClaudeCliCreds)(
    'runs Builder with Stop Hook, Dispute Arbiter, Auditor, and Git Merge in an isolated git worktree',
    async () => {
      const repoDir = mkdtempSync(path.join(tmpdir(), 'harness-e2e-loop-'));
      tempDirs.push(repoDir);
      execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir });
      execFileSync('git', ['config', 'user.email', 'e2e@example.com'], { cwd: repoDir });
      execFileSync('git', ['config', 'user.name', 'E2E'], { cwd: repoDir });

      writeFileSync(
        path.join(repoDir, 'SPEC.md'),
        '# Math Spec\n§1.1: `add(a, b)` MUST return the exact sum `a + b` as a number.\n',
        'utf8',
      );
      writeFileSync(
        path.join(repoDir, 'add.mjs'),
        'export function add(a, b) { return a - b; }\n',
        'utf8',
      );
      writeFileSync(
        path.join(repoDir, 'test.mjs'),
        'import assert from "node:assert/strict";\nimport { add } from "./add.mjs";\nassert.equal(add(2, 3), 5);\nconsole.log("PASS");\n',
        'utf8',
      );
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-m', 'broken add'], { cwd: repoDir });

      const Acct = H.account(
        'sub-main',
        H.drivers.claudeCli({
          configDir: process.env.CLAUDE_CONFIG_DIR_1 ?? '~/.claude',
        }),
      );
      const Sonnet = H.model(Acct, 'claude-sonnet-5-5');
      const Haiku = H.model(Acct, 'claude-haiku-5-5');

      const RunNodeTest = H.command('node-test')
        .input(z.any())
        .output(z.object({ passed: z.boolean(), summary: z.string() }))
        .run(async ({ ctx, exec }) => {
          const r = await exec('node test.mjs', { cwd: ctx.workDir, reject: false });
          return { passed: r.exitCode === 0, summary: r.all };
        });

      const DisputeSchema = z.object({
        criterionId: z.string(),
        citation: z.string(),
        reason: z.string(),
      });

      const BuildSkill = H.skill('build-fix')
        .input(
          z.object({
            criteria: z.array(z.object({ id: z.string(), text: z.string() })),
          }),
        )
        .output(
          z.object({
            fixed: z.boolean(),
            disputes: z.array(DisputeSchema),
          }),
        )
        .prompt(
          (inp) =>
            `Fix add.mjs so node test.mjs passes. Also inspect criteria: ${JSON.stringify(inp.criteria)}. If any criterion contradicts SPEC.md §1.1, include a dispute for that criterionId citing SPEC.md §1.1.`,
        );

      const ArbitrateSkill = H.skill('arbitrate')
        .input(z.object({ disputes: z.array(DisputeSchema) }))
        .output(z.object({ overruledIds: z.array(z.string()) }))
        .prompt(
          (inp) =>
            `SPEC.md §1.1 says add(a, b) returns a + b as a number. Evaluate disputes: ${JSON.stringify(inp.disputes)}. Return overruledIds containing any criterionId whose dispute matches SPEC.md §1.1.`,
        );

      const AuditSkill = H.skill('audit')
        .input(
          z.object({
            overruledIds: z.array(z.string()),
            testPassed: z.boolean(),
          }),
        )
        .output(z.object({ deficits: z.array(z.string()), approved: z.boolean() }))
        .prompt(
          (inp) =>
            `Verify add.mjs fix. testPassed=${inp.testPassed}, overruledIds=${JSON.stringify(inp.overruledIds)}. If testPassed is true, return deficits: [] and approved: true.`,
        );

      const MergeBranch = H.command('merge-to-main')
        .input(z.any())
        .output(z.object({ merged: z.boolean() }))
        .run(async ({ ctx, exec }) => {
          await exec('git add add.mjs', { cwd: ctx.workDir });
          await exec('git commit -m "fix add" --allow-empty', { cwd: ctx.workDir });
          const shaRes = await exec('git rev-parse HEAD', { cwd: ctx.workDir });
          const sha = shaRes.stdout.trim();
          await exec(`git update-ref refs/heads/main ${sha}`, { cwd: ctx.projectDir });
          await exec('git checkout -f main', { cwd: ctx.projectDir });
          return { merged: true };
        });

      const Builder = H.agent('builder')
        .model(Sonnet)
        .prompt('You are the Builder. Fix add.mjs and report any spec contradiction in disputes.')
        .tools(['Read', 'Edit', 'Write', 'Bash'])
        .use(stopCommandHook(RunNodeTest));

      const Arbiter = H.agent('arbiter')
        .model(Haiku)
        .prompt('You are the Dispute Arbiter.');

      const Auditor = H.agent('auditor')
        .model(Haiku)
        .prompt('You are the Auditor.');

      const head = H.head().port(0);
      const orch = await startOrchestrator({ projectDir: repoDir, head });

      const flow = H.flow('live-coding-loop')
        .input(
          z.object({
            criteria: z.array(z.object({ id: z.string(), text: z.string() })),
          }),
        )
        .use(gitWorktreeIsolation({ baseBranch: 'main', cleanupOnSuccess: true }))
        .loop({
          maxIterations: 2,
          body: (round) =>
            round
              .step('build', Builder.run(BuildSkill, (ctx) => ctx.input))
              .step('testCheck', RunNodeTest)
              .when(
                (ctx) => ctx.steps.build.disputes.length > 0,
                (sub) =>
                  sub.step(
                    'arbitrate',
                    Arbiter.run(ArbitrateSkill, (ctx) => ({
                      disputes: ctx.steps.build.disputes,
                    })),
                  ),
              )
              .step(
                'audit',
                Auditor.run(AuditSkill, (ctx) => ({
                  overruledIds: ctx.steps.arbitrate?.overruledIds ?? [],
                  testPassed: ctx.steps.testCheck.passed,
                })),
              ),
          until: (ctx) => ctx.steps.audit.approved && ctx.steps.audit.deficits.length === 0,
        })
        .step('merge', MergeBranch);

      const res = await orch.engine.run(
        flow,
        {
          criteria: [
            { id: 'AC-1', text: 'add(2, 3) returns 5' },
            { id: 'AC-2', text: 'add(a, b) returns a formatted currency string instead of a number' },
          ],
        },
        { hookReceiver: orch.mcpServer },
      );

      expect.soft(res.steps.testCheck.passed).toBe(true);
      expect.soft(res.steps.audit.approved).toBe(true);
      expect.soft(res.steps.merge.merged).toBe(true);
      expect.soft(readFileSync(path.join(repoDir, 'add.mjs'), 'utf8')).toContain('a + b');
      await orch.close();
    },
    240_000,
  );
});
