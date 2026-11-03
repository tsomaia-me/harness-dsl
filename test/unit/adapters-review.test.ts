import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeCode } from '../../src/adapters/claude-code/index.js';
import { FinishedSessions } from '../../src/adapters/sessions.js';
import { ssh } from '../../src/adapters/ssh/index.js';
import type { CliSpawnBridge } from '../../src/drivers/cli-agent.js';
import { H } from '../../src/dsl/index.js';
import type { ModelRequest, Resolver } from '../../src/kernel/index.js';
import { SshRunner } from '../../src/runner.js';
import { fakeQuota } from './scenarios/doubles.js';

const resolver: Resolver = { env: (ref) => `secret-${ref.name}`, port: () => 0 };
const outputSchema = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'], additionalProperties: false };
const account = claudeCode.subscription('main', { quota: fakeQuota('q') });
const NO_SUCH_PID = 2_147_483_647;

function request(extra: Partial<ModelRequest> = {}): ModelRequest {
  return { seat: 'reviewer', model: 'claude-haiku-5-5', account, role: { name: 'reviewer', intents: ['read'], prompt: 'review' }, input: {}, memory: [], halts: [], outputSchema, idempotencyKey: 'u1/review', ...extra };
}

describe('the adapters after the cold review', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'harness-adapters-review-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a session as running while its agent lives, lost when it is gone, finished by its response', () => {
    const sessions = new FinishedSessions(path.join(dir, 'sessions'));
    expect.soft(sessions.status('k')).toEqual({ status: 'lost' });
    sessions.running('k', process.pid);
    expect.soft(sessions.status('k')).toEqual({ status: 'running' });
    sessions.remember('k', { output: 1, costUsd: 0, tokens: 1 });
    expect.soft(sessions.status('k')).toMatchObject({ status: 'finished', response: { output: 1 } });
    sessions.running('dead', NO_SUCH_PID);
    expect.soft(sessions.status('dead')).toEqual({ status: 'lost' });
    sessions.running('gone', process.pid);
    sessions.release('gone');
    expect(sessions.status('gone')).toEqual({ status: 'lost' });
  });

  it('the Claude CLI driver keeps the agent\'s pid while it runs, passes the cancel signal, and reports the list price of a prepaid call', async () => {
    let release: (() => void) | undefined;
    let seenSignal: AbortSignal | undefined;
    const spawnBridge: CliSpawnBridge = async (_args, _env, _cwd, onLine, _inactivity, signal, onSpawn) => {
      seenSignal = signal;
      onSpawn?.(process.pid);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      onLine(JSON.stringify({ type: 'result', structured_output: { result: { verdict: 'ship' } }, total_cost_usd: 0.42 }));
      return { exitCode: 0, stderr: '' };
    };
    const driver = claudeCode.driver({ spawnBridge, workDir: dir, sessionDir: path.join(dir, 'sessions') });
    const cancel = new AbortController();
    const invoking = driver.invoke(request({ cancel: cancel.signal }), resolver);
    while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
    expect.soft(await driver.session('u1/review', resolver)).toEqual({ status: 'running' });
    expect.soft(seenSignal).toBe(cancel.signal);
    release();
    expect.soft(await invoking).toMatchObject({ output: { verdict: 'ship' }, costUsd: 0, equivalentUsd: 0.42 });
    expect(await driver.session('u1/review', resolver)).toMatchObject({ status: 'finished', response: { costUsd: 0, equivalentUsd: 0.42 } });
  });

  it('an SSH host takes a user, a key from the environment and a work directory, and runs a command in its own cwd on the host', () => {
    const runner = new SshRunner('box', { host: 'deploy@box', workDir: '/srv/app', identityFile: '/keys/deploy', skipPreFlightCheck: true });
    const args = runner.buildSshCommandArgs('make deploy', 0, {}, '/srv/app/wt-1');
    expect.soft(args.slice(-2, -1)).toEqual(['deploy@box']);
    expect.soft(args).toContain('-i');
    expect.soft(args[args.indexOf('-i') + 1]).toBe('/keys/deploy');
    expect.soft(args.at(-1)).toContain("cd '\\''/srv/app/wt-1'\\'' &&");
    expect.soft(runner.buildSshCommandArgs('make deploy', 0).at(-1)).toContain("cd '\\''/srv/app'\\'' &&");
    const def = ssh.host('box', { host: 'box', user: 'deploy', key: H.env('DEPLOY_KEY'), workDir: '/srv/app', slots: 2 });
    expect(def).toMatchObject({ entity: 'runner', name: 'box' });
  });
});
