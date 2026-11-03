import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import type { MemoryFilter, MemoryItem, MemoryStore } from '../../kernel/backends.js';
import { parseWithDates, stringifyWithDates } from '../json-dates.js';

/** A memory store in one JSONL file: one item per line, rewritten on update. Never ranks. */
export class JsonlMemoryStore implements MemoryStore {
  public readonly entity = 'memoryStore' as const;
  public readonly name: string;
  private readonly file: string;

  public constructor(name: string, options: { readonly path: string }) {
    this.name = name;
    this.file = path.resolve(options.path);
    mkdirSync(path.dirname(this.file), { recursive: true });
  }

  private load(): MemoryItem[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => parseWithDates<MemoryItem>(line));
  }

  private save(items: readonly MemoryItem[]): void {
    writeFileSync(this.file, items.map((item) => `${stringifyWithDates(item)}\n`).join(''), 'utf8');
  }

  public async put(item: MemoryItem): Promise<void> {
    appendFileSync(this.file, `${stringifyWithDates(item)}\n`, 'utf8');
  }

  public async list(filter: MemoryFilter): Promise<readonly MemoryItem[]> {
    return this.load().filter((item) => item.journal === filter.journal && (!filter.status || filter.status.includes(item.status)));
  }

  public async update(id: string, change: Parameters<MemoryStore['update']>[1]): Promise<void> {
    this.save(this.load().map((item) => (item.id === id ? { ...item, ...change } : item)));
  }
}

export const jsonl = {
  memoryStore(name: string, options: { readonly path: string }): JsonlMemoryStore {
    return new JsonlMemoryStore(name, options);
  },
};
