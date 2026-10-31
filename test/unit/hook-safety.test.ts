import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FlowDef } from '../../src/dsl.js';
import { FlowEngine } from '../../src/engine.js';
import { H, HarnessMcpServer, z } from '../../src/index.js';
import { stopCommandHook } from '../../src/plugins/index.js';
import { claudeCodeHookProtocol, readClaudeCodeTranscriptTokens } from '../../src/protocols/claude-code.js';
import { RateLimitedError } from '../../src/quota.js';
import { openaiRateLimits } from '../../src/rate-limits/index.js';
import { HarnessStore } from '../../src/store.js';
import type { AgentPlugin, DriverInvokeResult, ExecutionContext } from '../../src/types.js';

const RUNAWAY = 25;
const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-safety-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function execCtx(store: HarnessStore, dir: string, extra: Partial<ExecutionContext> = {}): ExecutionContext {
  store.createRun({ id: 'run-s', flowName: 'f', workDir: dir, input: {} });
  return {
    runId: 'run-s',
    iteration: 0,
    stepName: 'step',
    projectDir: dir,
    workDir: dir,
    touchedPaths: [],
    store,
    signal: new AbortController().signal,
    ...extra,
  };
}

function okResult(structuredOutput: unknown, extra: Partial<DriverInvokeResult> = {}): DriverInvokeResult {
  return {
    structuredOutput,
    rawText: JSON.stringify(structuredOutput),
    sessionId: 'sess',
    usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, actualCostUsd: 0, equivalentCostUsd: 0 },
    ...extra,
  };
}

const okSkill = H.skill('s').input(z.object({})).output(z.object({ ok: z.boolean() }));

function blockingStop(name: string): AgentPlugin {
  return {
    name,
    stop: { handle: async () => ({ allow: false, reason: `${name} says no` }) },
  };
}

describe('Skill loop termination', () => {
  it('cools an account down for the policy default when a rate limit names a cooldown that is already over', async () => {
    const dir = makeDir();
    const store = new HarnessStore(dir);
    let calls = 0;
    const driver = H.drivers.custom({
      invoke: async (req) => {
        calls += 1;
        if (calls >= RUNAWAY) throw new Error('runaway retry loop');
        throw new RateLimitedError(req.accountId, '429', openaiRateLimits.fromHeaders({ 'retry-after': '0' }, Date.now()));
      },
    });
    const agent = H.agent('worker').model(H.model(H.account('only', driver), 'model-x'));
    const startedAt = Date.now();

    await expect(agent.run(okSkill).execute({}, execCtx(store, dir))).rejects.toThrow(/Quota exhausted/);
    expect.soft(calls).toBe(1);
    expect.soft(store.getAccountQuota('only')?.cooldownUntilMs ?? 0).toBeGreaterThanOrEqual(startedAt + 60_000);
    store.close();
  });

  it('fails the step after maxHandoffs consecutive handoffs', async () => {
    const dir = makeDir();
    const store = new HarnessStore(dir);
    let calls = 0;
    const driver = H.drivers.custom({
      invoke: async () => {
        calls += 1;
        if (calls >= RUNAWAY) throw new Error('runaway handoff loop');
        return okResult(undefined, { handoffRequested: { summary: 'half done', remainingWork: ['rest'] } });
      },
    });
    const agent = H.agent('worker').model(H.model(H.account('only', driver), 'model-x')).maxHandoffs(2);

    await expect(agent.run(okSkill).execute({}, execCtx(store, dir))).rejects.toThrow(/2 handoffs/);
    expect(calls).toBe(3);
    store.close();
  });
});

describe('Hook receiver safety', () => {
  function hookDriver(onInvoke: (invocationId: string) => Promise<void>) {
    return H.drivers.custom({
      hookProtocol: claudeCodeHookProtocol,
      invoke: async (req) => {
        await onInvoke(req.invocationId!);
        return okResult({ ok: true });
      },
    });
  }

  it('blocks Stop with the error when a plugin handler throws', async () => {
    const dir = makeDir();
    const store = new HarnessStore(dir);
    const server = new HarnessMcpServer(H.head(), store);
    const check = H.command('vitest').run(async () => {
      throw new Error('vitest exited with code 1');
    });
    server.register('inv-1', {
      runId: 'run-s',
      workDir: dir,
      protocol: claudeCodeHookProtocol,
      plugins: [stopCommandHook(check, { mapInput: ({ workDir }) => ({ workDir }), verdict: () => ({ allow: true }) })],
      customTools: new Map(),
    });

    const answer = await server.handleHookCallback('inv-1', { hook_event_name: 'Stop' });
    expect(answer).toMatchObject({ decision: 'block', reason: expect.stringContaining('vitest exited with code 1') });
    store.close();
  });

  it.each([
    { label: 'a single step', build: (exec: any): FlowDef<any, any> => H.flow('single').input(z.object({})).step('build', exec) },
    {
      label: 'an item of a local batch step',
      build: (exec: any): FlowDef<any, any> =>
        H.flow('batched').input(z.object({})).batch('build', { items: () => [{}], execute: exec }),
    },
  ])("answers the agent's stop hook with its plugins in $label", async ({ build }) => {
    const dir = makeDir();
    const store = new HarnessStore(dir);
    const server = new HarnessMcpServer(H.head(), store);
    const answers: Record<string, unknown>[] = [];
    const invocations: string[] = [];
    const driver = hookDriver(async (invocationId) => {
      invocations.push(invocationId);
      answers.push(await server.handleHookCallback(invocationId, { hook_event_name: 'Stop' }));
    });
    const agent = H.agent('builder').model(H.model(H.account('a', driver), 'model-x')).use(blockingStop('gate'));

    await new FlowEngine(store).run(build(agent.run(okSkill)), {}, { hookReceiver: server });
    expect.soft(answers).toEqual([{ decision: 'block', reason: 'gate says no' }]);
    expect(await server.handleHookCallback(invocations[0]!, { hook_event_name: 'Stop' })).toEqual({});
    store.close();
  });

  it('answers each parallel agent with its own plugins', async () => {
    const dir = makeDir();
    const store = new HarnessStore(dir);
    const server = new HarnessMcpServer(H.head(), store);
    const answers = new Map<string, Record<string, unknown>>();
    const agentWith = (name: string) =>
      H.agent(name)
        .model(
          H.model(
            H.account(`acct-${name}`, hookDriver(async (invocationId) => {
              answers.set(name, await server.handleHookCallback(invocationId, { hook_event_name: 'Stop' }));
            })),
            'model-x',
          ),
        )
        .use(blockingStop(`${name}-gate`));

    await new FlowEngine(store).run(
      H.flow('fan-out').input(z.object({})).parallel({ left: agentWith('left').run(okSkill), right: agentWith('right').run(okSkill) }),
      {},
      { hookReceiver: server },
    );
    expect.soft(answers.get('left')).toEqual({ decision: 'block', reason: 'left-gate says no' });
    expect.soft(answers.get('right')).toEqual({ decision: 'block', reason: 'right-gate says no' });
    store.close();
  });

  it('refuses to run an agent whose plugins its driver cannot deliver, or with no hook receiver', async () => {
    const dir = makeDir();
    const store = new HarnessStore(dir);
    const server = new HarnessMcpServer(H.head(), store);
    const noHooks = H.agent('a').model(H.model(H.account('x', H.drivers.mock({ responses: [{ structuredOutput: { ok: true } }] })), 'm'));
    const withHooks = H.agent('b').model(H.model(H.account('y', hookDriver(async () => undefined)), 'm'));
    const ctx = execCtx(store, dir, { hookReceiver: server });

    await expect(noHooks.use(blockingStop('gate')).run(okSkill).execute({}, ctx)).rejects.toThrow(
      /cannot deliver hook plugins/,
    );
    await expect(
      withHooks.use(blockingStop('gate')).run(okSkill).execute({}, { ...ctx, hookReceiver: undefined }),
    ).rejects.toThrow(/no hook receiver/);
    store.close();
  });

  it('measures the Head transcript with the Head protocol and ignores hooks from unknown invocations', async () => {
    const dir = makeDir();
    const store = new HarnessStore(dir);
    const headProtocol = { ...claudeCodeHookProtocol, name: 'head-cli', readContextTokens: () => 150_000 };
    const server = new HarnessMcpServer(H.head().headProtocol(headProtocol).contextNoticeThreshold(100_000), store);

    const notice = await server.handleHookCallback(null, { hook_event_name: 'PostToolUse', session_id: 'h', transcript_path: 'x' });
    expect.soft(notice).toMatchObject({ hookSpecificOutput: { additionalContext: expect.stringContaining('harness_handoff') } });
    expect.soft(store.getActiveHeadSession()?.contextTokens).toBe(150_000);
    expect.soft(await server.handleHookCallback('inv-gone', { hook_event_name: 'Stop' })).toEqual({});
    store.close();
  });

  it('reads the latest usage even when the last transcript line is longer than the tail it first reads', () => {
    const dir = makeDir();
    const transcript = path.join(dir, 'head.jsonl');
    const assistant = { type: 'assistant', message: { usage: { input_tokens: 10, cache_read_input_tokens: 189_990, output_tokens: 0 } } };
    const bigToolResult = { type: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(200_000) }] } };
    writeFileSync(transcript, `${JSON.stringify(assistant)}\n${JSON.stringify(bigToolResult)}\n`);
    expect(readClaudeCodeTranscriptTokens(transcript)).toBe(190_000);
  });

  it('hands off at the default buffer when a driver is invoked without one', async () => {
    let spawns = 0;
    const cli = H.drivers.claudeCli({
      spawnBridge: async (args, _env, _cwd, onLine) => {
        spawns += 1;
        if (args.includes('--resume')) {
          onLine(JSON.stringify({ type: 'result', structured_output: { summary: 's', remainingWork: [] } }));
          return { exitCode: 0, stderr: '' };
        }
        onLine(JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 80_000, output_tokens: 0 } } }));
        onLine(JSON.stringify({ type: 'result', structured_output: { done: false } }));
        return { exitCode: 0, stderr: '' };
      },
    });
    const result = await cli.invoke({
      accountId: 'a',
      modelId: 'm',
      modelOptions: {},
      systemPrompt: '',
      userPrompt: 'go',
      outputJsonSchema: { type: 'object' },
      workDir: tmpdir(),
      maxContextTokens: 100_000,
      runId: 'r',
      stepName: 's',
      inactivityTimeoutMs: 5_000,
      signal: new AbortController().signal,
    });
    expect.soft(spawns).toBe(2);
    expect(result.handoffRequested).toBeDefined();
  });
});
