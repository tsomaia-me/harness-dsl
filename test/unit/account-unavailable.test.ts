import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { H, z } from '../../src/index.js';
import { AccountUnavailableError, RateLimitedError } from '../../src/quota.js';
import { HarnessStore } from '../../src/store.js';
import type { DriverInvokeRequest, ExecutionContext } from '../../src/types.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function invokeRequest(): DriverInvokeRequest {
  return {
    accountId: 'acct',
    modelId: 'model-x',
    modelOptions: {},
    systemPrompt: '',
    userPrompt: 'do it',
    outputJsonSchema: { type: 'object' },
    workDir: tmpdir(),
    runId: 'run-u',
    stepName: 'step',
    inactivityTimeoutMs: 5_000,
    signal: new AbortController().signal,
  };
}

describe('Unavailable accounts', () => {
  it.each([
    { label: 'a logged-out CLI', lines: [{ type: 'result', is_error: true, result: 'Not logged in · Please run /login' }] },
    { label: 'a 401 from the API', lines: [{ type: 'result', is_error: true, api_error_status: 401, result: 'API Error' }] },
  ])('reports $label as an unavailable account, not a rate limit', async ({ lines }) => {
    const driver = H.drivers.claudeCli({
      spawnBridge: async (_args, _env, _cwd, onLine) => {
        for (const line of lines) onLine(JSON.stringify(line));
        return { exitCode: 1, stderr: '' };
      },
    });
    const error = await driver.invoke(invokeRequest()).catch((err: unknown) => err);
    expect.soft(error).toBeInstanceOf(AccountUnavailableError);
    expect(error).not.toBeInstanceOf(RateLimitedError);
  });

  it('reports an AI SDK 401 as an unavailable account', async () => {
    const fetch = (async () =>
      new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })) as typeof globalThis.fetch;
    const driver = H.drivers.aiSdk({ provider: 'openai', apiKey: 'bad-key', fetch });
    await expect(driver.invoke(invokeRequest())).rejects.toBeInstanceOf(AccountUnavailableError);
  });

  it('takes an unavailable account out of rotation, fails over, and shows why on the board', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harness-unavailable-'));
    tempDirs.push(dir);
    const store = new HarnessStore(dir);
    store.createRun({ id: 'run-u', flowName: 'f', workDir: dir, input: {} });
    const ctx: ExecutionContext = {
      runId: 'run-u',
      iteration: 0,
      stepName: 'step',
      projectDir: dir,
      workDir: dir,
      touchedPaths: [],
      store,
      signal: new AbortController().signal,
    };
    const loggedOut = H.account(
      'logged-out',
      H.drivers.custom({
        invoke: async (req) => {
          throw new AccountUnavailableError(req.accountId, 'Not logged in · Please run /login');
        },
      }),
    );
    const healthy = H.account('healthy', H.drivers.mock({ responses: [{ structuredOutput: { ok: true } }] }));
    const agent = H.agent('a').model(H.model(H.pool('p', [loggedOut, healthy]).strategy('priority'), 'm'));
    const startedAt = Date.now();

    await expect(
      agent.run(H.skill('s').input(z.object({})).output(z.object({ ok: z.boolean() }))).execute({}, ctx),
    ).resolves.toEqual({ ok: true });
    expect.soft(store.getAccountQuota('logged-out')?.cooldownUntilMs ?? 0).toBeGreaterThanOrEqual(startedAt + 15 * 60_000);
    expect.soft(readFileSync(store.boardPath, 'utf8')).toContain('UNAVAILABLE: Not logged in');
    store.close();
  });
});
