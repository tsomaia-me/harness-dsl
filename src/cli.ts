#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HarnessDef } from './dsl/harness.js';
import { processResolver } from './engine/resolver.js';
import { Runtime, type RuntimeOptions } from './engine/runtime.js';
import type { Ledger, ModelDriver, Resolver, UnitRecord } from './kernel/index.js';
import type { PortRef } from './kernel/refs.js';

/** What a harness module exports for the CLI: the definition, its drivers, and how to resolve references. */
export interface HarnessModule {
  readonly harness: HarnessDef;
  readonly drivers: readonly ModelDriver[];
  readonly resolver?: Resolver;
  readonly ports?: Readonly<Record<number, number>>;
  readonly hooks?: { readonly port: number | PortRef };
  readonly tickMs?: number;
}

export interface Command {
  readonly command: 'start' | 'status' | 'install';
  readonly module: string;
  readonly options: Readonly<Record<string, string | true>>;
}

export const USAGE = [
  'usage:',
  '  harness start <module> [--tick <ms>] [--hooks-port <port>]',
  '  harness status <module> [--lane <name>]',
  '  harness install --launchd|--systemd <module> [--name <label>] [--dir <folder>]',
  '',
  'The module is a JavaScript file exporting `harness` (the definition), `drivers`, and optionally',
  '`resolver`, `ports`, `hooks` and `tickMs`.',
].join('\n');

const BOOLEAN_FLAGS = new Set(['launchd', 'systemd']);

export function parseArgs(argv: readonly string[]): Command {
  const [command, ...rest] = argv;
  if (command !== 'start' && command !== 'status' && command !== 'install') throw new Error(USAGE);
  const options: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = rest[index + 1];
    if (!BOOLEAN_FLAGS.has(name) && next !== undefined && !next.startsWith('--')) {
      options[name] = next;
      index += 1;
    } else {
      options[name] = true;
    }
  }
  const module = positional[0];
  if (!module) throw new Error(USAGE);
  if (command === 'install' && !options.launchd && !options.systemd) throw new Error(USAGE);
  return { command, module: path.resolve(module), options };
}

export async function loadModule(file: string): Promise<HarnessModule> {
  const loaded = (await import(pathToFileURL(file).href)) as Partial<HarnessModule> & { readonly default?: Partial<HarnessModule> };
  const module = loaded.harness ? loaded : loaded.default;
  if (!module?.harness || !module.drivers) throw new Error(`${file} must export \`harness\` and \`drivers\``);
  return module as HarnessModule;
}

export function runtimeOptions(module: HarnessModule, options: Command['options']): RuntimeOptions {
  const hooksPort = typeof options['hooks-port'] === 'string' ? Number(options['hooks-port']) : undefined;
  const tick = typeof options.tick === 'string' ? Number(options.tick) : undefined;
  return {
    harness: module.harness,
    drivers: module.drivers,
    resolver: module.resolver ?? processResolver(module.ports),
    ...(hooksPort !== undefined ? { hooks: { port: hooksPort } } : module.hooks ? { hooks: module.hooks } : {}),
    ...(tick !== undefined ? { tickMs: tick } : module.tickMs !== undefined ? { tickMs: module.tickMs } : {}),
  };
}

/** Runs the harness until a termination signal; the daemon entry point. */
export async function start(module: HarnessModule, options: Command['options'], signals: NodeJS.Process = process): Promise<Runtime> {
  const runtime = new Runtime(runtimeOptions(module, options));
  const stop = () => {
    void runtime.stop();
  };
  signals.once('SIGINT', stop);
  signals.once('SIGTERM', stop);
  await runtime.run();
  return runtime;
}

function cell(value: string | undefined): string {
  return (value ?? '—').replace(/\|/g, '/');
}

/** The board in text: every lane's units by position, and each open attempt. */
export async function statusReport(ledger: Ledger, lane?: string): Promise<string> {
  const records = await ledger.units(lane ? { lane } : {});
  const byLane = new Map<string, UnitRecord[]>();
  for (const record of records) byLane.set(record.unit.lane, [...(byLane.get(record.unit.lane) ?? []), record]);
  const lines: string[] = [];
  for (const [name, units] of [...byLane.entries()].sort(([p], [q]) => p.localeCompare(q))) {
    const counts = { pending: 0, active: 0, waiting: 0, terminal: 0 };
    for (const record of units) counts[record.unit.position] += 1;
    lines.push(`${name}: ${units.length} units (${counts.pending} pending, ${counts.active} active, ${counts.waiting} waiting, ${counts.terminal} terminal)`);
    for (const record of units.filter((candidate) => candidate.unit.position !== 'terminal')) {
      const attempt = record.unit.attempt;
      lines.push(`  ${cell(record.unit.key)}  ${record.unit.state}  ${record.unit.position}${attempt ? `  attempt ${attempt.number} ${attempt.status} at ${attempt.step}${attempt.blockedOn ? ` (${attempt.blockedOn}${attempt.halt ? `: ${attempt.halt}` : ''})` : ''}` : ''}`);
    }
  }
  return lines.length > 0 ? lines.join('\n') : 'no units';
}

export interface InstallOptions {
  readonly label: string;
  readonly module: string;
  readonly cli: string;
  readonly node: string;
  readonly dir: string;
  readonly logDir: string;
}

export function launchdPlist(options: InstallOptions): { readonly file: string; readonly text: string; readonly hint: string } {
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const file = path.join(options.dir, `${options.label}.plist`);
  const text = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${escape(options.label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...[options.node, options.cli, 'start', options.module].map((arg) => `    <string>${escape(arg)}</string>`),
    '  </array>',
    `  <key>WorkingDirectory</key><string>${escape(path.dirname(options.module))}</string>`,
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    `  <key>StandardOutPath</key><string>${escape(path.join(options.logDir, `${options.label}.log`))}</string>`,
    `  <key>StandardErrorPath</key><string>${escape(path.join(options.logDir, `${options.label}.err.log`))}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
  return { file, text, hint: `launchctl load -w ${file}` };
}

export function systemdUnit(options: InstallOptions): { readonly file: string; readonly text: string; readonly hint: string } {
  const file = path.join(options.dir, `${options.label}.service`);
  const quote = (value: string) => (/[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value);
  const text = [
    '[Unit]',
    `Description=harness ${options.label}`,
    'After=network-online.target',
    '',
    '[Service]',
    `ExecStart=${[options.node, options.cli, 'start', options.module].map(quote).join(' ')}`,
    `WorkingDirectory=${path.dirname(options.module)}`,
    'Restart=always',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
  return { file, text, hint: `systemctl --user daemon-reload && systemctl --user enable --now ${options.label}` };
}

export function install(command: Command, module: HarnessModule, cli: string, node: string): { readonly file: string; readonly hint: string } {
  const label = typeof command.options.name === 'string' ? command.options.name : `harness.${module.harness.name}`;
  const launchd = command.options.launchd === true;
  const dir = typeof command.options.dir === 'string' ? command.options.dir : launchd ? path.join(homedir(), 'Library', 'LaunchAgents') : path.join(homedir(), '.config', 'systemd', 'user');
  const logDir = typeof command.options['log-dir'] === 'string' ? command.options['log-dir'] : path.join(homedir(), 'Library', 'Logs', 'harness');
  const options: InstallOptions = { label, module: command.module, cli, node, dir, logDir };
  const unit = launchd ? launchdPlist(options) : systemdUnit(options);
  mkdirSync(dir, { recursive: true });
  if (launchd) mkdirSync(logDir, { recursive: true });
  writeFileSync(unit.file, unit.text, 'utf8');
  return { file: unit.file, hint: unit.hint };
}

export async function main(argv: readonly string[]): Promise<void> {
  const command = parseArgs(argv);
  const module = await loadModule(command.module);
  if (command.command === 'start') {
    await start(module, command.options);
    return;
  }
  if (command.command === 'status') {
    const ledger = module.harness.ledgerDef;
    if (!ledger) throw new Error(`harness "${module.harness.name}" has no ledger`);
    process.stdout.write(`${await statusReport(ledger, typeof command.options.lane === 'string' ? command.options.lane : undefined)}\n`);
    ledger.close();
    return;
  }
  const installed = install(command, module, path.resolve(new URL(import.meta.url).pathname), process.execPath);
  process.stdout.write(`wrote ${installed.file}\nthen: ${installed.hint}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
