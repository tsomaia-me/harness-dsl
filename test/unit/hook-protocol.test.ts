import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeCodeHookProtocol } from '../../src/protocols/claude-code.js';

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
    expect.soft(settings.hooks.PreToolUse[0].matcher).toBe('Edit|Write|MultiEdit|NotebookEdit');
    expect
      .soft(
        claudeCodeHookProtocol.parse({
          hook_event_name: 'PreToolUse',
          tool_name: 'NotebookEdit',
          tool_input: { notebook_path: '/repo/analysis.ipynb', new_source: 'x' },
        }),
      )
      .toMatchObject({ intent: 'file-write', filePaths: ['/repo/analysis.ipynb'] });
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
    expect.soft(event).toMatchObject({
      phase: 'pre-tool',
      intent: 'file-write',
      toolName: 'Write',
      filePaths: ['/repo/apps/edge/wallet.ts'],
      sessionId: 'sess-9',
      transcriptPath,
      raw: { tool_input: { content: 'x' } },
    });
    expect.soft(claudeCodeHookProtocol.readContextTokens(transcriptPath)).toBe(35);
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
});
