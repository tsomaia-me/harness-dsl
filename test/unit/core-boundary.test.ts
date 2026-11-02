import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = path.join(import.meta.dirname, '../../src');
const CORE_DIRS = ['kernel', 'dsl', 'engine'];
const ADAPTER_PREFIXES = ['adapters/', 'drivers/', 'batch/', 'presets/', 'pricing/', 'protocols/', 'rate-limits/'];
const ADAPTER_FILES = ['runner', 'types', 'hooks', 'defaults'];
const PROVIDER_VOCABULARY = [
  'anthropic',
  'claude',
  'openai',
  'gemini',
  'x-ratelimit',
  'retry-after',
  'tool_input',
  'hookspecificoutput',
  'hook_event_name',
  'pretooluse',
  'edit|write',
  'mcpservers',
];

function filesUnder(dir: string): string[] {
  return readdirSync(path.join(SRC, dir)).flatMap((entry) => {
    const full = path.join(SRC, dir, entry);
    return statSync(full).isDirectory() ? filesUnder(`${dir}/${entry}`) : entry.endsWith('.ts') ? [`${dir}/${entry.replace(/\.ts$/, '')}`] : [];
  });
}

const CORE_FILES = [...CORE_DIRS.flatMap(filesUnder), 'index'];

function relativeImports(file: string): string[] {
  const source = readFileSync(path.join(SRC, `${file}.ts`), 'utf8');
  return ts
    .preProcessFile(source, true, true)
    .importedFiles.map((imported) => imported.fileName)
    .filter((specifier) => specifier.startsWith('.'))
    .map((specifier) => path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)).replace(/\.js$/, ''));
}

function adapterImports(file: string): string[] {
  return relativeImports(file).filter((imported) => ADAPTER_PREFIXES.some((prefix) => imported.startsWith(prefix)) || ADAPTER_FILES.includes(imported));
}

function vocabularyIn(file: string): string[] {
  const source = readFileSync(path.join(SRC, `${file}.ts`), 'utf8');
  const body = source.replace(/^(?:import|export)[\s\S]*?from\s+['"][^'"]+['"];?$/gm, '');
  return PROVIDER_VOCABULARY.filter((term) => body.toLowerCase().includes(term));
}

describe('Core boundary', () => {
  it.each(CORE_FILES)('src/%s.ts imports no adapter module and names no provider, CLI or project', (file) => {
    expect({ adapterModules: adapterImports(file), vocabulary: vocabularyIn(file) }).toStrictEqual({ adapterModules: [], vocabulary: [] });
  });
});
