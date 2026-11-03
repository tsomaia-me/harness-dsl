import { describe, expect, it } from 'vitest';
import { claudeCodeHookProtocol } from '../../src/protocols/claude-code.js';

describe('Hook protocols', () => {
  it('round-trips Claude Code hook settings, payloads and decisions', () => {
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
      tool_name: 'Write',
      tool_input: { file_path: '/repo/apps/edge/wallet.ts', content: 'x' },
    });
    expect.soft(event).toMatchObject({
      phase: 'pre-tool',
      intent: 'file-write',
      toolName: 'Write',
      filePaths: ['/repo/apps/edge/wallet.ts'],
      sessionId: 'sess-9',
      raw: { tool_input: { content: 'x' } },
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
});
