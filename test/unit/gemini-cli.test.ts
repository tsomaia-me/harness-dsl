import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approvalModeFor, geminiCli, geminiCliGuardProtocol } from '../../src/adapters/gemini-cli/index.js';
import { H } from '../../src/dsl/index.js';
import { AccountRefusedError } from '../../src/kernel/index.js';
import type { ModelRequest, Resolver } from '../../src/kernel/index.js';
import { fakeQuota } from './scenarios/doubles.js';

const resolver: Resolver = { env: (ref) => `secret-${ref.name}`, port: () => 0 };
const quota = fakeQuota('q');
const outputSchema = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'], additionalProperties: false };
const account = geminiCli.account('gemini', { apiKey: H.env('GEMINI_API_KEY'), quota });
const flash = geminiCli.model('flash', { id: 'gemini-3.5-flash-lite' });

function request(extra: Partial<ModelRequest> = {}): ModelRequest {
  return {
    seat: 'reviewer',
    model: flash.id,
    account,
    role: { name: 'reviewer', intents: ['read', 'edit'], prompt: 'review abc' },
    input: { sha: 'abc' },
    memory: [],
    halts: [],
    outputSchema,
    idempotencyKey: 'u1/review',
    ...extra,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function flag(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}

const success = (text: string) => [
  { type: 'init', session_id: 'sess-1', model: 'gemini-3.5-flash-lite' },
  { type: 'message', role: 'user', content: 'review abc' },
  { type: 'message', role: 'assistant', content: text.slice(0, 5), delta: true },
  { type: 'message', role: 'assistant', content: text.slice(5), delta: true },
  { type: 'result', status: 'success', stats: { total_tokens: 8434, input_tokens: 8433, output_tokens: 1, cached: 6000, input: 2433, duration_ms: 1743, tool_calls: 0 } },
];

describe('the gemini-cli adapter', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'harness-gemini-cli-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function bridge(lines: readonly Record<string, unknown>[], exit = { exitCode: 0, stderr: '' }, during?: (cwd: string) => void) {
    const calls: { args: string[]; env: Record<string, string>; cwd: string }[] = [];
    const spawnBridge = async (args: readonly string[], env: Record<string, string>, cwd: string, onLine: (line: string) => void) => {
      calls.push({ args: [...args], env, cwd });
      during?.(cwd);
      for (const line of lines) onLine(JSON.stringify(line));
      return exit;
    };
    return { calls, spawnBridge };
  }

  it('declares the account and model under the gemini-cli driver and maps intents to an approval mode', () => {
    expect.soft(account).toMatchObject({ entity: 'account', driver: 'gemini-cli', credential: { ref: 'env', name: 'GEMINI_API_KEY' } });
    expect.soft(flash).toMatchObject({ entity: 'model', driver: 'gemini-cli', batch: false });
    expect.soft(approvalModeFor(['read'])).toBe('plan');
    expect.soft(approvalModeFor(['read', 'edit'])).toBe('auto_edit');
    expect(approvalModeFor(['edit', 'run'])).toBe('yolo');
  });

  it('runs gemini -p with the key in the env, a session from the step, the schema in the prompt, and parses the fenced JSON answer', async () => {
    const { calls, spawnBridge } = bridge(success('```json\n{"result":{"verdict":"ship"}}\n```'));
    const driver = geminiCli.driver({ spawnBridge, workDir: dir, sessionDir: path.join(dir, 'sessions') });
    expect.soft(driver).toMatchObject({ driver: 'gemini-cli', hooks: true });
    const response = await driver.invoke(request(), resolver);
    const [call] = calls;
    expect.soft(flag(call!.args, '-m')).toBe('gemini-3.5-flash-lite');
    expect.soft(flag(call!.args, '--output-format')).toBe('stream-json');
    expect.soft(flag(call!.args, '--approval-mode')).toBe('auto_edit');
    expect.soft(flag(call!.args, '--session-id')).toMatch(UUID);
    expect.soft(call!.env).toMatchObject({ GEMINI_API_KEY: 'secret-GEMINI_API_KEY', GEMINI_CLI_TRUST_WORKSPACE: 'true' });
    expect.soft(call!.cwd).toBe(dir);
    const prompt = flag(call!.args, '-p') ?? '';
    expect.soft(prompt).toContain('You are the "reviewer" seat.');
    expect.soft(prompt).toContain('review abc');
    expect.soft(prompt).toContain('"verdict"');
    expect.soft(response).toMatchObject({ output: { verdict: 'ship' }, tokens: 8434, sessionId: 'sess-1' });
    expect.soft(response.costUsd).toBeGreaterThan(0);
    expect.soft(await driver.session('u1/review', resolver)).toMatchObject({ status: 'finished', response: { output: { verdict: 'ship' } } });
    const again = await driver.invoke(request({ resume: { sessionId: 'sess-1', halt: 'approval', decision: { approved: true } } }), resolver);
    expect.soft(flag(calls[1]!.args, '--resume')).toBe('sess-1');
    expect.soft(flag(calls[1]!.args, '-p')).toContain('{"approved":true}');
    expect(again.output).toEqual({ verdict: 'ship' });
  });

  it.each([
    { label: 'a quota error', lines: [{ type: 'result', status: 'error', error: { type: 'unknown', message: '[API Error: 429 RESOURCE_EXHAUSTED, retry in 30 seconds]' }, stats: {} }], refusal: 'rateLimited', untilMs: 30_000 },
    { label: 'a bad key', lines: [{ type: 'result', status: 'error', error: { type: 'unknown', message: 'API key not valid. Please pass a valid API key.' }, stats: {} }], refusal: 'unavailable', untilMs: 15 * 60_000 },
  ])('turns $label into an account refusal with a cooldown', async ({ lines, refusal, untilMs }) => {
    const { spawnBridge } = bridge(lines, { exitCode: 1, stderr: '' });
    const driver = geminiCli.driver({ spawnBridge, workDir: dir, sessionDir: path.join(dir, 'sessions') });
    const before = Date.now();
    const error = await driver.invoke(request(), resolver).catch((err: unknown) => err);
    expect.soft(error).toBeInstanceOf(AccountRefusedError);
    expect.soft((error as AccountRefusedError).refusal).toBe(refusal);
    expect((error as AccountRefusedError).until.getTime()).toBeGreaterThanOrEqual(before + untilMs - 1_000);
  });

  it('two guarded runs in one workspace take turns at the settings file', async () => {
    const gates: (() => void)[] = [];
    const seen: string[] = [];
    const spawnBridge = async (_args: readonly string[], _env: Record<string, string>, cwd: string, onLine: (line: string) => void) => {
      seen.push(readFileSync(path.join(cwd, '.gemini', 'settings.json'), 'utf8'));
      await new Promise<void>((resolve) => gates.push(resolve));
      for (const line of success('{"result":{"verdict":"ship"}}')) onLine(JSON.stringify(line));
      return { exitCode: 0, stderr: '' };
    };
    const driver = geminiCli.driver({ spawnBridge, workDir: dir, sessionDir: path.join(dir, 'sessions') });
    const guard = (invocation: string) => ({ endpoint: 'http://127.0.0.1:4100', invocation, leases: true, stop: false });
    const first = driver.invoke(request({ idempotencyKey: 'u1/review', guard: guard('u1/review') }), resolver);
    const second = driver.invoke(request({ idempotencyKey: 'u2/review', guard: guard('u2/review') }), resolver);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect.soft(seen).toHaveLength(1);
    gates[0]!();
    await first;
    while (gates.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    gates[1]!();
    await second;
    expect.soft(seen.map((text) => /invocation=([^"&\\]+)/.exec(text)?.[1])).toEqual(['u1%2Freview', 'u2%2Freview']);
    expect(existsSync(path.join(dir, '.gemini', 'settings.json'))).toBe(false);
  });

  it('places hook settings in the workspace for a guarded step and restores the file after, and speaks the guard protocol', async () => {
    let seen: Record<string, any> | undefined;
    const { spawnBridge } = bridge(success('{"result":{"verdict":"ship"}}'), undefined, (cwd) => {
      seen = JSON.parse(readFileSync(path.join(cwd, '.gemini', 'settings.json'), 'utf8')) as Record<string, any>;
    });
    const driver = geminiCli.driver({ spawnBridge, workDir: dir, sessionDir: path.join(dir, 'sessions') });
    await driver.invoke(request({ guard: { endpoint: 'http://127.0.0.1:4100', invocation: 'u1/review', leases: true, stop: true } }), resolver);
    expect.soft(seen?.tools).toEqual({ enableHooks: true });
    expect.soft(seen?.hooks.BeforeTool[0].matcher).toBe('write_file|replace');
    expect.soft(seen?.hooks.BeforeTool[0].hooks[0].command).toContain('http://127.0.0.1:4100/internal/hook?invocation=u1%2Freview');
    expect.soft(seen?.hooks.AfterAgent[0].hooks[0].type).toBe('command');
    expect.soft(existsSync(path.join(dir, '.gemini', 'settings.json'))).toBe(false);

    expect.soft(geminiCliGuardProtocol.parse({ hook_event_name: 'BeforeTool', tool_name: 'write_file', tool_input: { file_path: 'src/a.ts', content: 'x' } })).toMatchObject({ phase: 'pre-tool', filePaths: ['src/a.ts'] });
    expect.soft(geminiCliGuardProtocol.parse({ hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command: 'ls' } })).toMatchObject({ phase: 'pre-tool', filePaths: [] });
    expect.soft(geminiCliGuardProtocol.parse({ hook_event_name: 'AfterAgent' })).toMatchObject({ phase: 'stop' });
    expect.soft(geminiCliGuardProtocol.parse({ hook_event_name: 'SessionStart' })).toBeNull();
    const event = geminiCliGuardProtocol.parse({ hook_event_name: 'BeforeTool', tool_name: 'replace', tool_input: { file_path: 'b.ts' } })!;
    expect.soft(geminiCliGuardProtocol.formatDecision(event, { allow: true })).toEqual({});
    expect(geminiCliGuardProtocol.formatDecision(event, { allow: false, reason: 'leased' })).toEqual({ decision: 'deny', reason: 'leased' });
  });
});
