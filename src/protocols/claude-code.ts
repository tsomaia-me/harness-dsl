import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import type { HookProtocol, ToolEvent, ToolEventPhase } from '../types.js';

const TRANSCRIPT_TAIL_BYTES = 65_536;
const FILE_WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit'];

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

function latestUsageTotal(text: string): number | null {
  let latest: number | null = null;
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, any>;
      const usage = parsed.message?.usage ?? parsed.usage;
      if (usage && typeof usage === 'object') {
        const total =
          Number(usage.input_tokens ?? 0) +
          Number(usage.cache_creation_input_tokens ?? 0) +
          Number(usage.cache_read_input_tokens ?? 0) +
          Number(usage.output_tokens ?? 0);
        if (total > 0) latest = total;
      }
    } catch {
      continue;
    }
  }
  return latest;
}

export function readClaudeCodeTranscriptTokens(transcriptPath: string): number {
  if (!existsSync(transcriptPath)) return 0;
  try {
    const size = statSync(transcriptPath).size;
    const fd = openSync(transcriptPath, 'r');
    try {
      for (let tail = TRANSCRIPT_TAIL_BYTES; ; tail *= 4) {
        const readSize = Math.min(size, tail);
        const buf = Buffer.alloc(readSize);
        readSync(fd, buf, 0, readSize, size - readSize);
        const latest = latestUsageTotal(buf.toString('utf8'));
        if (latest !== null) return latest;
        if (readSize === size) return 0;
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    return 0;
  }
}

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
    const filePath = toolInput.file_path ?? toolInput.path;
    const transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path : undefined;
    const event: ToolEvent = {
      phase,
      intent: FILE_WRITE_TOOLS.includes(String(payload.tool_name)) ? 'file-write' : null,
      ...(typeof payload.tool_name === 'string' ? { toolName: payload.tool_name } : {}),
      filePaths: typeof filePath === 'string' && filePath.length > 0 ? [filePath] : [],
      ...(typeof payload.session_id === 'string' ? { sessionId: payload.session_id } : {}),
      ...(transcriptPath ? { transcriptPath } : {}),
      raw: payload,
    };
    return event;
  },

  formatDecision(event, decision) {
    if (!decision.allow) {
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
    }
    if (decision.additionalContext) {
      return {
        hookSpecificOutput: {
          hookEventName: EVENT_BY_PHASE[event.phase],
          additionalContext: decision.additionalContext,
        },
      };
    }
    return {};
  },

  readContextTokens: readClaudeCodeTranscriptTokens,
};
