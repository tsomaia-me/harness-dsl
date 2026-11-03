import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ModelResponse, SessionStatus } from '../kernel/backends.js';
import { parseWithDates, stringifyWithDates } from './json-dates.js';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * What `session` answers after a crash of the harness, on disk by idempotency key: the finished
 * response of a call that ended, or the pid of the agent a call spawned, which says whether that
 * agent is still running.
 */
export class FinishedSessions {
  public constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private file(key: string, suffix: 'json' | 'running'): string {
    return path.join(this.dir, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.${suffix}`);
  }

  /** The call's agent runs in this process; the marker outlives a crash of the harness. */
  public running(key: string, pid: number): void {
    writeFileSync(this.file(key, 'running'), JSON.stringify({ pid, startedAt: new Date().toISOString() }), 'utf8');
  }

  public remember(key: string, response: ModelResponse): void {
    writeFileSync(this.file(key, 'json'), stringifyWithDates(response), 'utf8');
    rmSync(this.file(key, 'running'), { force: true });
  }

  /** The call ended without a response (a refusal, an abort, a failure): its agent is gone. */
  public release(key: string): void {
    rmSync(this.file(key, 'running'), { force: true });
  }

  public status(key: string): SessionStatus {
    const finished = this.file(key, 'json');
    if (existsSync(finished)) return { status: 'finished', response: parseWithDates<ModelResponse>(readFileSync(finished, 'utf8')) };
    const marker = this.file(key, 'running');
    if (!existsSync(marker)) return { status: 'lost' };
    const { pid } = JSON.parse(readFileSync(marker, 'utf8')) as { readonly pid: number };
    if (alive(pid)) return { status: 'running' };
    rmSync(marker, { force: true });
    return { status: 'lost' };
  }
}
