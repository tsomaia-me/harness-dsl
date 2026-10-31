import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { H, startOrchestrator, z } from '../../src/index.js';
import { fileLeaseGuard } from '../../src/plugins/index.js';
import { claudeCodeHookProtocol } from '../../src/protocols/claude-code.js';
import { HarnessStore } from '../../src/store.js';
import type { ExecutionContext, HookProtocol } from '../../src/types.js';

describe('Hook protocols', () => {
  const tempDirs: string[] = [];

  function makeDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'harness-hooks-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips Claude Code hook settings, payloads and decisions', () => {
    const dir = makeDir();
    const transcriptPath = path.join(dir, 'transcript.jsonl');
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({ message: { usage: { input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 5 } } })}\n`,
    );

    const settings = claudeCodeHookProtocol.buildSettings('http://127.0.0.1:4100/internal/hook?runId=r1', {
      preToolIntents: ['file-write'],
      stop: true,
    }) as Record<string, any>;
    expect.soft(settings.hooks.PreToolUse[0].matcher).toBe('Edit|Write|MultiEdit');
    expect.soft(settings.hooks.PreToolUse[0].hooks[0].command).toContain('"http://127.0.0.1:4100/internal/hook?runId=r1"');
    expect.soft(settings.hooks.Stop[0].hooks[0].type).toBe('command');
    expect.soft(Object.keys(settings.hooks)).toEqual(['PreToolUse', 'Stop']);

    const event = claudeCodeHookProtocol.parse({
      hook_event_name: 'PreToolUse',
      session_id: 'sess-9',
      transcript_path: transcriptPath,
      tool_name: 'Write',
      tool_input: { file_path: '/repo/apps/edge/wallet.ts', content: 'x' },
    });
    expect.soft(event).toStrictEqual({
      phase: 'pre-tool',
      intent: 'file-write',
      filePaths: ['/repo/apps/edge/wallet.ts'],
      sessionId: 'sess-9',
      transcriptPath,
      contextTokens: 35,
    });
    expect
      .soft(claudeCodeHookProtocol.parse({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }))
      .toMatchObject({ phase: 'pre-tool', intent: null, filePaths: [] });

    expect.soft(claudeCodeHookProtocol.formatDecision(event!, { allow: true })).toStrictEqual({});
    expect.soft(claudeCodeHookProtocol.formatDecision(event!, { allow: false, reason: 'leased' })).toStrictEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'leased' },
    });
    const stop = claudeCodeHookProtocol.parse({ hook_event_name: 'Stop' });
    expect.soft(claudeCodeHookProtocol.formatDecision(stop!, { allow: false, reason: 'tests red' })).toStrictEqual({
      decision: 'block',
      reason: 'tests red',
    });
  });

  it('enforces fileLeaseGuard through a non-Claude hook protocol', async () => {
    const dir = makeDir();
    const stubProtocol: HookProtocol = {
      name: 'stub-cli',
      buildSettings: () => ({}),
      parse: (payload) => ({
        phase: payload.when === 'before' ? 'pre-tool' : 'stop',
        intent: payload.action === 'save' ? 'file-write' : null,
        filePaths: [String(payload.target)],
      }),
      formatDecision: (_event, decision) => ({ ok: decision.allow, why: decision.reason ?? null }),
    };
    const orch = await startOrchestrator({ projectDir: dir, head: H.head().port(0).hookProtocol(stubProtocol) });
    orch.mcpServer.registerRunPlugins('run-A', [fileLeaseGuard()], dir);
    orch.mcpServer.registerRunPlugins('run-B', [fileLeaseGuard()], dir);
    const post = (runId: string, action: string) =>
      fetch(`${orch.mcpServer.url}/internal/hook?protocol=stub-cli&runId=${runId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ when: 'before', action, target: path.join(dir, 'ledger.ts') }),
      }).then((r) => r.json());

    expect.soft(await post('run-A', 'save')).toEqual({ ok: true, why: null });
    expect.soft(await post('run-B', 'save')).toMatchObject({ ok: false, why: expect.stringContaining('run-A') });
    expect.soft(await post('run-B', 'open')).toEqual({ ok: true, why: null });
    await orch.close();
  });

  it('grounds the Head with the configured transcript reader', async () => {
    const dir = makeDir();
    const orch = await startOrchestrator({
      projectDir: dir,
      head: H.head().port(0).transcriptReader((transcriptPath) => (transcriptPath === 'head.log' ? 42_000 : 0)),
    });
    const client = new Client({ name: 'reader-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(orch.mcpUrl)));
    const res = await client.callTool({ name: 'harness_ground', arguments: { sessionId: 'h', transcriptPath: 'head.log' } });
    expect(JSON.parse((res.content as any)[0].text).contextTokens).toBe(42_000);
    await client.close();
    await orch.close();
  });

  it.each([
    { label: 'the default 30K buffer hands off at 80K of a 100K ceiling', buffer: undefined, expectedSpawns: 3 },
    { label: 'a 10K buffer keeps working at 80K', buffer: 10_000, expectedSpawns: 1 },
  ])('$label', async ({ buffer, expectedSpawns }) => {
    const dir = makeDir();
    const store = new HarnessStore(dir);
    store.createRun({ id: 'run-ho', flowName: 'f', workDir: dir, input: {} });
    const ctx: ExecutionContext = {
      runId: 'run-ho',
      iteration: 0,
      stepName: 'step',
      projectDir: dir,
      workDir: dir,
      touchedPaths: [],
      store,
      signal: new AbortController().signal,
    };
    let spawns = 0;
    const cli = H.drivers.claudeCli({
      spawnBridge: async (args, _env, _cwd, onLine) => {
        spawns += 1;
        if (args.includes('--resume')) {
          onLine(JSON.stringify({ type: 'result', structured_output: { summary: 'half', remainingWork: ['rest'] } }));
          return { exitCode: 0, stderr: '' };
        }
        const done = spawns > 1;
        onLine(JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: done ? 1_000 : 80_000, output_tokens: 0 } } }));
        onLine(JSON.stringify({ type: 'result', structured_output: { done } }));
        return { exitCode: 0, stderr: '' };
      },
    });
    const base = H.agent('builder').model(H.model(H.account('cli', cli), 'claude-opus-5-5')).maxContextTokens(100_000);
    const agent = buffer === undefined ? base : base.handoffBuffer(buffer);
    await agent.run(H.skill('s').input(z.object({})).output(z.object({ done: z.boolean() }))).execute({}, ctx);
    expect(spawns).toBe(expectedSpawns);
    store.close();
  });
});
