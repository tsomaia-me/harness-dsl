import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { claudeCode } from '../../src/adapters/claude-code/index.js';
import { http } from '../../src/adapters/http/index.js';
import { markdown } from '../../src/adapters/markdown/index.js';
import { slack } from '../../src/adapters/slack/index.js';
import { SqliteLedger } from '../../src/adapters/sqlite/ledger.js';
import { H } from '../../src/dsl/index.js';
import { Runtime } from '../../src/engine/runtime.js';
import type { Resolver } from '../../src/kernel/index.js';
import { fakeAccount, fakeModel, fakeQuota, ScriptedDriver } from './scenarios/doubles.js';

const resolver: Resolver = { env: (ref) => `secret-${ref.name}`, port: () => 0 };
const T = new Date('2026-11-02T12:00:00Z');

const Open = H.state('Open', 'pending');
const Done = H.terminal('Done', 'success');
const Rejected = H.terminal('Rejected', 'failure');
const Task = H.kind('Task').attributes(z.object({ title: z.string() })).states(Open, Done, Rejected).key((a) => a.title).initial(Open);
const workerRole = H.role('worker').input(z.object({ title: z.string() })).output(z.object({ verdict: z.string() })).prompt((i) => `work on ${i.title}`);
const approval = H.halt('approval').decision(z.object({ approved: z.boolean() }));

describe('clients and observers', () => {
  let dir: string;
  let ledger: SqliteLedger;
  let runtime: Runtime;
  let clock: Date;
  const slackPosts: { url: string; body: any }[] = [];
  const slackFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    slackPosts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
  const ops = http.controlApi('ops', { port: 0, token: H.env('OPS_TOKEN'), grants: [H.ops.work.create, H.ops.work.read, H.ops.resolve(approval)] });
  const viewer = http.controlApi('viewer', { port: 0, token: H.env('VIEW_TOKEN'), grants: [H.ops.work.read] });
  const head = claudeCode.supervisor('head', { port: 0, grants: [H.ops.work.create, H.ops.work.read, H.ops.resolve(approval), H.ops.telemetry.read] });

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'harness-clients-'));
    ledger = new SqliteLedger({ path: path.join(dir, 'ledger.sqlite') });
    clock = T;
    slackPosts.length = 0;
    const worker = H.seat('worker').role(workerRole).model(fakeModel('m', 'test', 'm-id')).pool(H.pool('p').accounts(fakeAccount('x', 'test', fakeQuota('q'))));
    const flow = H.flow('work')
      .input(z.object({ title: z.string() }))
      .step('work', worker, (ctx) => ({ title: ctx.unit.attributes.title }))
      .halt('approval', approval, { ask: (ctx) => `approve ${ctx.unit.attributes.title}?` })
      .exit('rejected', (ctx) => !ctx.steps.approval.approved)
      .exit('done');
    const tasks = H.lane('tasks', Task).supply(H.operator).handler(flow, { exits: { done: Done, rejected: Rejected } }).retry({ tries: 0, exhausted: Rejected }).on(H.cancel, { enter: Rejected });
    const harness = H.harness('observed')
      .ledger(ledger)
      .lanes(tasks)
      .scheduler(H.scheduler('s').standard(tasks))
      .clients(ops, viewer, head)
      .observers(markdown.board('board', { path: path.join(dir, 'BOARD.md') }), markdown.telemetry('telemetry', { path: path.join(dir, 'TELEMETRY.md') }), slack.observer('alerts', { webhook: H.env('SLACK_WEBHOOK'), fetch: slackFetch }));
    runtime = new Runtime({ harness, drivers: [new ScriptedDriver(() => ({ output: { verdict: 'ok' }, costUsd: 0.5, tokens: 10 }))], resolver, now: () => clock, holder: 'observed' });
    await runtime.start();
  });

  afterEach(async () => {
    await runtime.stop();
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves the control API over HTTP with a bearer token and the client\'s grants', async () => {
    const base = ops.url();
    const headers = { authorization: 'Bearer secret-OPS_TOKEN', 'content-type': 'application/json' };
    expect.soft((await fetch(`${base}/operations`)).status).toBe(401);
    const listed = (await (await fetch(`${base}/operations`, { headers })).json()) as { operations: { name: string }[] };
    expect.soft(listed.operations.map((operation) => operation.name)).toEqual(['work.create', 'work.read', 'halts.resolve']);

    const events = new AbortController();
    const stream = await fetch(`${base}/events`, { headers, signal: events.signal });
    expect.soft(stream.status).toBe(200);
    const reader = stream.body!.getReader();

    const created = (await (await fetch(`${base}/operations/work.create`, { method: 'POST', headers, body: JSON.stringify({ lane: 'tasks', attributes: { title: 'one' } }) })).json()) as { unitId: string };
    expect.soft(created.unitId).toMatch(/^unit-/);
    const refused = await fetch(`${viewer.url()}/operations/work.create`, { method: 'POST', headers: { authorization: 'Bearer secret-VIEW_TOKEN', 'content-type': 'application/json' }, body: JSON.stringify({ lane: 'tasks', attributes: { title: 'two' } }) });
    expect.soft(refused.status).toBe(403);
    expect.soft(((await refused.json()) as { error: string }).error).toMatch(/may not call "work.create"/);
    const bad = await fetch(`${base}/operations/work.create`, { method: 'POST', headers, body: JSON.stringify({ lane: 'nope', attributes: {} }) });
    expect.soft(bad.status).toBe(400);

    let text = '';
    while (!/\ndata: /.test(text) && !text.startsWith('data: ')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    events.abort();
    const line = text.split('\n').find((candidate) => candidate.startsWith('data: '))!;
    const first = JSON.parse(line.slice('data: '.length)) as { seq: number; event: { type: string } };
    expect(first).toMatchObject({ seq: expect.any(Number), event: { type: 'unitCreated' } });
  });

  it('serves a Claude Code supervisor over MCP and writes the session config', async () => {
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(head.url())));
    const tools = await client.listTools();
    expect.soft(tools.tools.map((tool) => tool.name)).toEqual(['work_create', 'work_read', 'halts_resolve', 'telemetry_read']);
    const created = await client.callTool({ name: 'work_create', arguments: { lane: 'tasks', attributes: { title: 'mcp' } } });
    const text = (created.content as { type: string; text: string }[])[0]!.text;
    expect.soft(JSON.parse(text)).toMatchObject({ unitId: expect.stringMatching(/^unit-/) });
    const refused = await client.callTool({ name: 'halts_resolve', arguments: { unitId: 'unit-none', decision: {} } });
    expect.soft(refused.isError).toBe(true);
    await client.close();

    const session = claudeCode.session('owner', { endpoints: [head] });
    expect.soft(session.mcpConfig(resolver)).toEqual({ mcpServers: { head: { type: 'http', url: `${head.url()}` } } });
    const written = session.write(dir, resolver);
    expect.soft(written).toBe(path.join(dir, '.mcp.json'));
    expect(existsSync(written)).toBe(true);
  });

  it('projects the board and telemetry from the event stream and posts asks to Slack', async () => {
    const unit = (await runtime.createUnit(runtime.lane('tasks'), { title: 'one' }, { source: 'test' }))!;
    await runtime.tick();
    const board = readFileSync(path.join(dir, 'BOARD.md'), 'utf8');
    expect.soft(board).toContain('## tasks');
    expect.soft(board).toMatch(/\| one \| Open \| waiting \| approval \| approve one\? \|/);
    expect.soft(slackPosts.map((post) => [post.url, post.body.text])).toEqual([['secret-SLACK_WEBHOOK', expect.stringContaining('approve one?')]]);

    await runtime.resolveHalt(unit, { approved: true }, 'owner');
    await runtime.tick();
    const telemetry = readFileSync(path.join(dir, 'TELEMETRY.md'), 'utf8');
    expect.soft(telemetry).toMatch(/\| tasks \| 1 \| 1 \| 0 \|/);
    expect.soft(telemetry).toMatch(/\| worker \| m \| 1 \| 1 \| 0 \|/);
    expect.soft(telemetry).toContain('$0.50');
    expect(readFileSync(path.join(dir, 'BOARD.md'), 'utf8')).toMatch(/\| one \| Done \| terminal \|/);
  });
});
