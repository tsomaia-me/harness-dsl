import type { HookProtocol, ToolEvent, ToolEventPhase } from '../types.js';

const FILE_WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

const PHASE_BY_EVENT: Readonly<Record<string, ToolEventPhase>> = {
  PreToolUse: 'pre-tool',
  PostToolUse: 'post-tool',
  Stop: 'stop',
};

const EVENT_BY_PHASE: Readonly<Record<ToolEventPhase, string>> = {
  'pre-tool': 'PreToolUse',
  'post-tool': 'PostToolUse',
  stop: 'Stop',
};

export const claudeCodeHookProtocol: HookProtocol = {
  name: 'claude-code',

  buildSettings(endpoint, subscriptions) {
    const hook = {
      type: 'command',
      command: `curl -sS -X POST "${endpoint}" -H "content-type: application/json" --data-binary @-`,
    };
    return {
      hooks: {
        ...(subscriptions.preToolIntents.includes('file-write')
          ? { PreToolUse: [{ matcher: FILE_WRITE_TOOLS.join('|'), hooks: [hook] }] }
          : {}),
        ...(subscriptions.stop ? { Stop: [{ hooks: [hook] }] } : {}),
      },
    };
  },

  parse(payload) {
    const phase = PHASE_BY_EVENT[String(payload.hook_event_name)];
    if (!phase) return null;
    const toolInput = (payload.tool_input ?? {}) as Record<string, unknown>;
    const filePath = toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path;
    const event: ToolEvent = {
      phase,
      intent: FILE_WRITE_TOOLS.includes(String(payload.tool_name)) ? 'file-write' : null,
      ...(typeof payload.tool_name === 'string' ? { toolName: payload.tool_name } : {}),
      filePaths: typeof filePath === 'string' && filePath.length > 0 ? [filePath] : [],
      ...(typeof payload.session_id === 'string' ? { sessionId: payload.session_id } : {}),
      raw: payload,
    };
    return event;
  },

  formatDecision(event, decision) {
    if (decision.allow) return {};
    const reason = decision.reason ?? 'Blocked by harness';
    return event.phase === 'pre-tool'
      ? {
          hookSpecificOutput: {
            hookEventName: EVENT_BY_PHASE[event.phase],
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          },
        }
      : { decision: 'block', reason };
  },
};
