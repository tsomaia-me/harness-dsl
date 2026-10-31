import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.join(import.meta.dirname, '../../src');
const CORE_FILES = ['dsl', 'engine', 'hooks', 'mcp', 'quota', 'runner', 'schema', 'store', 'types'];
const COMPOSITION_ROOTS = new Set(['dsl']);
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
  'edit|write',
];

const IMPORT_STATEMENT = /^import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"];?$/gm;

function adapterImports(source: string): { readonly specifier: string; readonly names: string[] }[] {
  return [...source.matchAll(IMPORT_STATEMENT)]
    .filter((match) => ADAPTER_DIRS.some((dir) => match[2]!.startsWith(`./${dir}/`)))
    .map((match) => ({
      specifier: match[2]!,
      names: match[1]!.split(',').map((name) => name.replace(/^\s*type\s+/, '').trim()).filter(Boolean),
    }));
}

function codeWithoutImports(source: string, wiredNames: readonly string[]): string {
  const body = source.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?$/gm, '');
  return wiredNames.reduce((code, name) => code.replaceAll(name, ''), body);
}

describe('Core boundary', () => {
  it.each(CORE_FILES)('src/%s.ts names no provider, CLI or project', (file) => {
    const source = readFileSync(path.join(SRC, `${file}.ts`), 'utf8');
    const imports = adapterImports(source);
    const isRoot = COMPOSITION_ROOTS.has(file);
    const code = codeWithoutImports(source, isRoot ? imports.flatMap((i) => i.names) : []).toLowerCase();
    expect({
      adapterImports: isRoot ? [] : imports.map((i) => i.specifier),
      vocabulary: PROVIDER_VOCABULARY.filter((term) => code.includes(term)),
    }).toStrictEqual({ adapterImports: [], vocabulary: [] });
  });
});
