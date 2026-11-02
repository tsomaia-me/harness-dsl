import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ModelResponse, SessionStatus } from '../kernel/backends.js';
import { parseWithDates, stringifyWithDates } from './json-dates.js';

/** Finished responses by idempotency key, on disk, so `session` can answer after a crash of the harness. */
export class FinishedSessions {
  public constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private file(key: string): string {
    return path.join(this.dir, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`);
  }

  public remember(key: string, response: ModelResponse): void {
    writeFileSync(this.file(key), stringifyWithDates(response), 'utf8');
  }

  public status(key: string): SessionStatus {
    const file = this.file(key);
    if (!existsSync(file)) return { status: 'lost' };
    return { status: 'finished', response: parseWithDates<ModelResponse>(readFileSync(file, 'utf8')) };
  }
}
