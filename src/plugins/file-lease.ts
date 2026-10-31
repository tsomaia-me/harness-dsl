import path from 'node:path';
import type { AgentPlugin } from '../types.js';

export function fileLeaseGuard(): AgentPlugin {
  return {
    name: 'fileLeaseGuard',
    hookTypes: ['PreToolUse'],
    async onPreToolUse(payload, ctx) {
      const toolInput = (payload.tool_input ?? payload.input ?? {}) as Record<string, unknown>;
      const rawPath =
        (typeof toolInput.file_path === 'string' && toolInput.file_path) ||
        (typeof toolInput.path === 'string' && toolInput.path) ||
        '';
      if (!rawPath) {
        return { allow: true };
      }

      const absPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(ctx.workDir, rawPath);
      const relPath = path.relative(ctx.workDir, absPath).replace(/\\/g, '/');
      const normalized = relPath.startsWith('..') ? absPath.replace(/\\/g, '/') : relPath;

      const lease = ctx.store.acquireFileLease(ctx.runId, normalized);
      if (!lease.ok) {
        return {
          allow: false,
          reason: `File "${normalized}" is currently leased by active run "${lease.holderRunId}". Wait or work on a disjoint file.`,
        };
      }
      return { allow: true };
    },
  };
}
