import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { AiSdkDriver } from '../../src/drivers/ai-sdk.js';
import { ClaudeCliDriver } from '../../src/drivers/claude-cli.js';
import { AccountUnavailableError, RateLimitedError } from '../../src/drivers/errors.js';
import type { DriverInvokeRequest } from '../../src/types.js';

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
    const driver = new ClaudeCliDriver({
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
    const driver = new AiSdkDriver({ provider: 'openai', apiKey: 'bad-key', fetch });
    await expect(driver.invoke(invokeRequest())).rejects.toBeInstanceOf(AccountUnavailableError);
  });
});
