import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { H } from '../../src/dsl.js';
import { HarnessStore } from '../../src/store.js';
import type { ExecutionContext } from '../../src/types.js';

describe('Drivers, Skills, Commands, and Agent Execution', () => {
  const tempDirs: string[] = [];

  function makeContext(): { store: HarnessStore; ctx: ExecutionContext; dir: string } {
    const dir = mkdtempSync(path.join(tmpdir(), 'harness-drivers-test-'));
    tempDirs.push(dir);
    const store = new HarnessStore(dir);
    store.createRun({
      id: 'run-drv',
      flowName: 'test-flow',
      workDir: dir,
      input: {},
    });
    const ctx: ExecutionContext = {
      runId: 'run-drv',
      iteration: 0,
      stepName: 'step-1',
      projectDir: dir,
      workDir: dir,
      slotIndex: 0,
      slotPorts: [18000, 18001, 18002],
      touchedPaths: ['apps/admin/src/UsersPage.tsx'],
      store,
      hookServerUrl: 'http://127.0.0.1:4100',
      signal: new AbortController().signal,
    };
    return { store, ctx, dir };
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('auto-retries on Zod schema or semantic .assert() failure with resumeSession=true and succeeds after self-correction', async () => {
    const { store, ctx } = makeContext();

    store.addLesson({
      kind: 'domain',
      roles: ['auditor'],
      paths: ['apps/admin/**'],
      rule: 'Verify Mantine table pagination props.',
    });
    store.addLesson({
      kind: 'domain',
      roles: ['builder'],
      paths: ['apps/edge/**'],
      rule: 'Never use raw SQL loops in D1.',
    });

    const mock = H.drivers.mock({
      responses: [
        { structuredOutput: { passed: 'not-a-boolean', score: 50 } },
        { structuredOutput: { passed: true, score: 40 } },
        { structuredOutput: { passed: true, score: 95 } },
      ],
    });

    const acct = H.account('mock-acct', mock);
    const model = H.model(acct, 'claude-opus-4-6');

    const ReviewSkill = H.skill('review')
      .input(z.object({ file: z.string() }))
      .output(z.object({ passed: z.boolean(), score: z.number() }))
      .assert((out) => {
        if (out.passed && out.score < 80) {
          throw new Error('Passing review requires score >= 80');
        }
      })
      .maxRetries(2);

    const Auditor = H.agent('auditor')
      .model(model)
      .prompt('You are a strict auditor.')
      .tools(['Read', 'Grep']);

    const bound = Auditor.run(ReviewSkill);
    const output = await bound.execute({ file: 'UsersPage.tsx' }, ctx);

    expect.soft(output).toEqual({ passed: true, score: 95 });
    expect.soft(mock.calls.length).toBe(3);
    expect.soft(mock.calls[0]!.resumeSession).toBe(false);
    expect.soft(mock.calls[1]!.resumeSession).toBe(true);
    expect.soft(mock.calls[2]!.resumeSession).toBe(true);
    expect.soft(mock.calls[0]!.systemPrompt).toContain('Verify Mantine table pagination props.');
    expect.soft(mock.calls[0]!.systemPrompt).not.toContain('Never use raw SQL loops in D1.');
    expect.soft(mock.calls[1]!.userPrompt).toContain('Output failed Zod validation');
    expect.soft(mock.calls[2]!.userPrompt).toContain('Passing review requires score >= 80');
    store.close();
  });

  it('parses claude-cli stream-json events, runs 1-turn --resume handoff on context ceiling, and parses rate-limit reset timestamps', async () => {
    const { store, ctx } = makeContext();

    const rateLimitedCli = H.drivers.claudeCli({
      configDir: '~/.claude-1',
      spawnBridge: async () => ({
        exitCode: 1,
        stderr: 'Error 429: Rate limit reached, resets in 5 minutes',
      }),
    });

    const seenArgs: string[][] = [];
    let callNum = 0;
    const healthyCli = H.drivers.claudeCli({
      configDir: '~/.claude-2',
      spawnBridge: async (args, _env, _cwd, onLine) => {
        seenArgs.push([...args]);
        callNum += 1;
        if (callNum === 1) {
          onLine(
            JSON.stringify({
              type: 'assistant',
              message: {
                usage: {
                  input_tokens: 180_000,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 45_000,
                  output_tokens: 5_000,
                },
                content: [{ type: 'text', text: 'Completed part 1, context nearly full' }],
              },
            }),
          );
          onLine(
            JSON.stringify({
              type: 'result',
              structured_output: { done: false },
            }),
          );
          return { exitCode: 0, stderr: '' };
        }

        if (callNum === 2) {
          onLine(
            JSON.stringify({
              type: 'result',
              structured_output: {
                summary: 'Part 1 complete',
                remainingWork: ['Finish part 2'],
              },
            }),
          );
          return { exitCode: 0, stderr: '' };
        }

        onLine(
          JSON.stringify({
            type: 'assistant',
            message: {
              usage: {
                input_tokens: 12_000,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 8_000,
                output_tokens: 1_200,
              },
            },
          }),
        );
        onLine(
          JSON.stringify({
            type: 'result',
            structured_output: { done: true },
          }),
        );
        return { exitCode: 0, stderr: '' };
      },
    });

    const pool = H.pool('cli-pool', [
      H.account('cli-1', rateLimitedCli),
      H.account('cli-2', healthyCli),
    ]).strategy('priority');

    const WorkSkill = H.skill('work')
      .input(z.object({ task: z.string() }))
      .output(z.object({ done: z.boolean() }));

    const HelperTool = H.command('helper-tool')
      .input(z.object({ q: z.string() }))
      .output(z.object({ a: z.string() }))
      .run(async ({ input }) => ({ a: input.q }));

    const Worker = H.agent('worker')
      .model(H.model(pool, 'claude-opus-4-6'))
      .maxContextTokens(250_000)
      .tools(['Read'])
      .tool('ask_helper', HelperTool);

    const out = await Worker.run(WorkSkill).execute({ task: 'implement feature' }, ctx);
    expect.soft(out).toEqual({ done: true });
    expect.soft(callNum).toBe(3);
    expect.soft(seenArgs[0]).toContain('--mcp-config');
    expect.soft(seenArgs[0]?.join(' ')).toContain('mcp__harness__ask_helper');
    expect.soft(seenArgs[1]).toContain('--resume');
    expect.soft(seenArgs[2]?.join(' ')).toContain('Part 1 complete');

    const quota1 = store.getAccountQuota('cli-1');
    expect.soft((quota1?.cooldownUntilMs ?? 0) > Date.now() + 240_000).toBe(true);
    store.close();
  });

  it('executes H.command with .envFrom() and preserves handler across .run().input().output()', async () => {
    const { store, ctx, dir } = makeContext();
    writeFileSync(path.join(dir, '.env.custom'), 'SECRET_TOKEN="alpha-99"\n', 'utf8');

    const EchoCmd = H.command('echo-env')
      .envFrom('.env.custom')
      .run(async ({ input, exec }) => {
        const res = await exec('node -e "process.stdout.write(process.env.SECRET_TOKEN)"');
        return { combined: `${(input as { prefix: string }).prefix}:${res.stdout}` };
      })
      .input(z.object({ prefix: z.string() }))
      .output(z.object({ combined: z.string() }));

    const out = await EchoCmd.execute({ prefix: 'val' }, ctx);
    expect(out).toEqual({ combined: 'val:alpha-99' });
    store.close();
  });
});
