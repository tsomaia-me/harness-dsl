import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = path.join(import.meta.dirname, '../../src');
const CORE_FILES = ['dsl', 'engine', 'hooks', 'defaults', 'mcp', 'quota', 'runner', 'schema', 'store', 'types'];
const PLUGIN_FILES = readdirSync(path.join(SRC, 'plugins')).map((file) => `plugins/${file.replace(/\.ts$/, '')}`);
const COMPOSITION_ROOT = 'dsl';
const ADAPTER_DIRS = ['batch', 'drivers', 'presets', 'pricing', 'protocols', 'rate-limits'];
const PROVIDER_VOCABULARY = [
  'anthropic',
  'claude',
  'openai',
  'gemini',
  'x-ratelimit',
  'retry-after',
  'port_api',
  'port_web',
  'port_admin',
  'tool_input',
  'hookspecificoutput',
  'hook_event_name',
  'pretooluse',
  'edit|write',
  'mcpservers',
];
const KNOWN_UNTIL_HEAD_CLIENT_ADAPTER: Readonly<Record<string, readonly string[]>> = { mcp: ['mcpservers'] };

function relativeImports(file: string): string[] {
  const source = readFileSync(path.join(SRC, `${file}.ts`), 'utf8');
  return ts
    .preProcessFile(source, true, true)
    .importedFiles.map((imported) => imported.fileName)
    .filter((specifier) => specifier.startsWith('.'))
    .map((specifier) => path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)).replace(/\.js$/, ''));
}

function reachableAdapterModules(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  const reached: string[] = [];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (ADAPTER_DIRS.some((dir) => file.startsWith(`${dir}/`))) {
      reached.push(file);
      continue;
    }
    if (file === COMPOSITION_ROOT) continue;
    queue.push(...relativeImports(file));
  }
  return reached;
}

function vocabularyIn(file: string): string[] {
  const source = readFileSync(path.join(SRC, `${file}.ts`), 'utf8');
  const wiredNames =
    file === COMPOSITION_ROOT
      ? [...source.matchAll(/^import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]\.\/(?:batch|drivers|presets|pricing|protocols|rate-limits)\//gm)].flatMap(
          (match) => match[1]!.split(',').map((name) => name.replace(/^\s*type\s+/, '').trim()).filter(Boolean),
        )
      : [];
  const body = wiredNames.reduce(
    (code, name) => code.replaceAll(name, ''),
    source.replace(/^(?:import|export)[\s\S]*?from\s+['"][^'"]+['"];?$/gm, ''),
  );
  const allowed = new Set(KNOWN_UNTIL_HEAD_CLIENT_ADAPTER[file] ?? []);
  return PROVIDER_VOCABULARY.filter((term) => !allowed.has(term) && body.toLowerCase().includes(term));
}

describe('Core boundary', () => {
  it.each(CORE_FILES)('src/%s.ts reaches no adapter module and names no provider, CLI or project', (file) => {
    expect({
      adapterModules: file === COMPOSITION_ROOT ? [] : reachableAdapterModules(file),
      vocabulary: vocabularyIn(file),
    }).toStrictEqual({ adapterModules: [], vocabulary: [] });
  });

  it.each(PLUGIN_FILES)('src/%s.ts names no provider, CLI or project', (file) => {
    expect(vocabularyIn(file)).toStrictEqual([]);
  });
});
