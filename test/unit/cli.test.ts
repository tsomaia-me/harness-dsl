import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SqliteLedger } from '../../src/adapters/sqlite/ledger.js';
import { install, launchdPlist, parseArgs, runtimeOptions, start, statusReport, systemdUnit, USAGE, type HarnessModule } from '../../src/cli.js';
import { H } from '../../src/dsl/index.js';
import { Runtime } from '../../src/engine/runtime.js';
import type { Resolver } from '../../src/kernel/index.js';
import { fakeAccount, fakeModel, fakeQuota, ScriptedDriver } from './scenarios/doubles.js';

const resolver: Resolver = { env: (ref) => ref.name, port: () => 0 };
const Open = H.state('Open', 'pending');
const Done = H.terminal('Done', 'success');
const Failed = H.terminal('Failed', 'failure');
const Task = H.kind('Task').attributes(z.object({ title: z.string() })).states(Open, Done, Failed).key((a) => a.title).initial(Open);
const workerRole = H.role('worker').input(z.object({ title: z.string() })).output(z.object({ verdict: z.string() })).prompt((i) => `work on ${i.title}`);
const approval = H.halt('approval').decision(z.object({ approved: z.boolean() }));

describe('the harness CLI', () => {
  let dir: string;
  let ledger: SqliteLedger;
  let module: HarnessModule;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'harness-cli-'));
    ledger = new SqliteLedger({ path: path.join(dir, 'ledger.sqlite') });
    const worker = H.seat('worker').role(workerRole).model(fakeModel('m', 'test', 'm-id')).pool(H.pool('p').accounts(fakeAccount('x', 'test', fakeQuota('q'))));
    const flow = H.flow('work')
      .input(z.object({ title: z.string() }))
      .step('work', worker, (ctx) => ({ title: ctx.unit.attributes.title }))
      .halt('approval', approval, { ask: (ctx) => `approve ${ctx.unit.attributes.title}?`, timeout: { afterMinutes: 1, decide: () => ({ approved: true }) } })
      .exit('rejected', (ctx) => !ctx.steps.approval.approved)
      .exit('done');
    const tasks = H.lane('tasks', Task).supply(H.operator).handler(flow, { exits: { done: Done, rejected: Failed } }).retry({ tries: 0, exhausted: Failed }).on(H.cancel, { enter: Failed });
    const harness = H.harness('demo').ledger(ledger).lanes(tasks).scheduler(H.scheduler('s').standard(tasks));
    module = { harness, drivers: [new ScriptedDriver(() => ({ output: { verdict: 'ok' }, costUsd: 0, tokens: 1 }))], resolver, tickMs: 10 };
  });

  afterEach(() => {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses the three commands and refuses the rest', () => {
    expect.soft(parseArgs(['start', 'h.js', '--tick', '500'])).toEqual({ command: 'start', module: path.resolve('h.js'), options: { tick: '500' } });
    expect.soft(parseArgs(['status', 'h.js', '--lane', 'tasks']).options).toEqual({ lane: 'tasks' });
    expect.soft(parseArgs(['install', '--launchd', 'h.js', '--name', 'demo']).options).toEqual({ launchd: true, name: 'demo' });
    expect.soft(() => parseArgs(['install', 'h.js'])).toThrow(USAGE);
    expect.soft(() => parseArgs(['restart', 'h.js'])).toThrow(USAGE);
    expect(runtimeOptions(module, { 'hooks-port': '4100', tick: '250' })).toMatchObject({ hooks: { port: 4100 }, tickMs: 250 });
  });

  it('starts the runtime, ticks until a signal, and reports the status', async () => {
    const signals = new (class extends (await import('node:events')).EventEmitter {})() as unknown as NodeJS.Process;
    const running = start(module, {}, signals);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const runtime = new Runtime({ harness: module.harness, drivers: module.drivers, resolver, holder: 'probe' });
    await expect(runtime.start()).rejects.toThrow(/ledger is held/);
    signals.emit('SIGTERM');
    const stopped = await running;
    expect.soft(stopped).toBeInstanceOf(Runtime);
    const probe = new Runtime({ harness: module.harness, drivers: module.drivers, resolver, holder: 'probe' });
    await probe.start();
    const unit = (await probe.createUnit(probe.lane('tasks'), { title: 'one' }, { source: 'cli-test' }))!;
    await probe.tick();
    await probe.stop();
    const report = await statusReport(ledger);
    expect.soft(report).toContain('tasks: 1 units (0 pending, 0 active, 1 waiting, 0 terminal)');
    expect.soft(report).toContain('one  Open  waiting  attempt 1 blocked at approval (decision: approval)');
    expect.soft(await statusReport(ledger, 'other')).toBe('no units');
    void unit;
  });

  it('writes a launchd plist or a systemd unit that starts the module', () => {
    const options = { label: 'harness.demo', module: '/srv/demo/harness.js', cli: '/opt/harness/dist/cli.js', node: '/usr/local/bin/node', dir, logDir: path.join(dir, 'logs') };
    const plist = launchdPlist(options);
    expect.soft(plist.file).toBe(path.join(dir, 'harness.demo.plist'));
    expect.soft(plist.text).toContain('<string>/opt/harness/dist/cli.js</string>\n    <string>start</string>\n    <string>/srv/demo/harness.js</string>');
    expect.soft(plist.text).toContain('<key>KeepAlive</key><true/>');
    expect.soft(plist.hint).toContain('launchctl load -w');
    const unit = systemdUnit(options);
    expect.soft(unit.text).toContain('ExecStart=/usr/local/bin/node /opt/harness/dist/cli.js start /srv/demo/harness.js');
    expect.soft(unit.text).toContain('Restart=always');
    const installed = install({ command: 'install', module: '/srv/demo/harness.js', options: { systemd: true, dir } }, module, '/opt/harness/dist/cli.js', '/usr/local/bin/node');
    expect.soft(installed.file).toBe(path.join(dir, 'harness.demo.service'));
    expect(readFileSync(installed.file, 'utf8')).toContain('Description=harness harness.demo');
  });
});
