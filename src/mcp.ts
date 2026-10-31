import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { HeadDef } from './dsl.js';
import { FlowEngine } from './engine.js';
import { HOOK_PATH } from './hooks.js';
import { LocalRunner } from './runner.js';
import { type HarnessStore, sumCosts } from './store.js';
import type { AgentPlugin, Executable, ExecutionContext } from './types.js';

export class HarnessMcpServer {
  public readonly headDef: HeadDef;
  public readonly store: HarnessStore;
  public readonly engine: FlowEngine;
  private httpServer?: Server;
  public boundPort = 0;
  private readonly activeRunPlugins = new Map<
    string,
    {
      plugins: readonly AgentPlugin[];
      workDir: string;
      customTools?: ReadonlyMap<string, Executable<any, any>>;
    }
  >();
  private readonly activeRunControllers = new Map<string, AbortController>();

  public constructor(headDef: HeadDef, store: HarnessStore, engine?: FlowEngine) {
    this.headDef = headDef;
    this.store = store;
    this.engine = engine ?? new FlowEngine(store);
  }

  public get url(): string {
    return `http://127.0.0.1:${this.boundPort}`;
  }

  public get mcpUrl(): string {
    return `${this.url}/mcp`;
  }

  public registerRunPlugins(
    runId: string,
    plugins: readonly AgentPlugin[],
    workDir: string,
    customTools?: ReadonlyMap<string, Executable<any, any>>,
  ): void {
    this.activeRunPlugins.set(runId, { plugins, workDir, customTools });
  }

  public unregisterRunPlugins(runId: string): void {
    this.activeRunPlugins.delete(runId);
  }

  public async start(portOverride?: number): Promise<{ port: number; mcpUrl: string }> {
    const targetPort = portOverride ?? this.headDef.listenPort;
    this.httpServer = createServer((req, res) => {
      void this.handleHttpRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && targetPort !== 0) {
          this.httpServer!.listen(0, '127.0.0.1', () => resolve());
        } else {
          reject(err);
        }
      });
      this.httpServer!.listen(targetPort, '127.0.0.1', () => resolve());
    });

    const address = this.httpServer.address() as AddressInfo;
    this.boundPort = address.port;

    const mcpConfigPath = path.join(this.store.projectDir, '.mcp.json');
    const mcpConfig = {
      mcpServers: {
        harness: {
          type: 'http',
          url: this.mcpUrl,
        },
      },
    };
    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2) + '\n', 'utf8');

    return { port: this.boundPort, mcpUrl: this.mcpUrl };
  }

  public async stop(): Promise<void> {
    for (const ctrl of this.activeRunControllers.values()) {
      ctrl.abort();
    }
    this.activeRunControllers.clear();
    if (!this.httpServer) return;
    await new Promise<void>((resolve) => {
      this.httpServer!.close(() => resolve());
    });
    this.httpServer = undefined;
  }

  private formatMcpResult(payload: Record<string, unknown>) {
    const activeHead = this.store.getActiveHeadSession();
    if (activeHead?.transcriptPath) {
      const tokens = this.headDef.transcriptReaderFn(activeHead.transcriptPath);
      if (tokens > 0 && tokens !== activeHead.contextTokens) {
        this.store.upsertHeadSession({
          sessionId: activeHead.sessionId,
          contextTokens: tokens,
        });
      }
    }
    const updatedHead = this.store.getActiveHeadSession();
    const overThreshold =
      updatedHead !== null &&
      updatedHead.contextTokens >= this.headDef.contextNoticeThresholdTokens;

    const responseObj = overThreshold
      ? {
          ...payload,
          contextWarning: `Head context usage (${updatedHead.contextTokens} tokens) reached threshold (${this.headDef.contextNoticeThresholdTokens}). Call harness_handoff({ note }) and compact or rotate.`,
        }
      : payload;

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(responseObj, null, 2),
        },
      ],
    };
  }

  private buildMcpServerInstance(): McpServer {
    const server = new McpServer({
      name: 'harness-orchestrator',
      version: '0.1.0',
    });

    server.registerTool(
      'harness_ground',
      {
        description: 'Ground the Head session on live queue, blocker, account, and lesson state',
        inputSchema: {
          sessionId: z.string().optional(),
          transcriptPath: z.string().optional(),
        },
      },
      async (args) => {
        const existing = this.store.getActiveHeadSession();
        const priorHandoffNote = existing?.handoffNote ?? null;
        const sessionId = args.sessionId ?? existing?.sessionId ?? `head-${randomUUID()}`;
        const contextTokens = args.transcriptPath
          ? this.headDef.transcriptReaderFn(args.transcriptPath)
          : (existing?.contextTokens ?? 0);

        this.store.upsertHeadSession({
          sessionId,
          transcriptPath: args.transcriptPath,
          contextTokens,
          handoffNote: '',
        });

        return this.formatMcpResult({
          sessionId,
          contextTokens,
          priorHandoffNote,
          runs: this.store.listRuns(),
          blockedRuns: this.store.listRuns().filter((r) => r.status === 'blocked'),
          quotas: this.store.listAccountQuotas(),
          lessons: this.store.filterLessons('head'),
        });
      },
    );

    server.registerTool(
      'harness_handoff',
      {
        description: 'Save a handoff note for the next Head session before compacting or rotating',
        inputSchema: {
          note: z.string(),
        },
      },
      async (args) => {
        const existing = this.store.getActiveHeadSession();
        this.store.upsertHeadSession({
          sessionId: existing?.sessionId ?? `head-${randomUUID()}`,
          handoffNote: args.note,
        });
        return this.formatMcpResult({ ok: true, savedNote: args.note });
      },
    );

    const caps = this.headDef.capabilitySet;

    if (caps.has('workflows:read')) {
      server.registerTool(
        'workflow_status',
        {
          description: 'List all workflow runs and their current status',
          inputSchema: {},
        },
        async () => this.formatMcpResult({ runs: this.store.listRuns() }),
      );

      server.registerTool(
        'workflow_inspect_run',
        {
          description: 'Inspect a specific workflow run and its invocations',
          inputSchema: { runId: z.string() },
        },
        async ({ runId }) =>
          this.formatMcpResult({
            run: this.store.getRun(runId),
            invocations: this.store.listInvocations(runId),
          }),
      );
    }

    if (caps.has('workflows:control')) {
      server.registerTool(
        'workflow_start',
        {
          description: 'Start a registered workflow by flowName',
          inputSchema: {
            flowName: z.string(),
            input: z.record(z.string(), z.any()).optional(),
            runId: z.string().optional(),
          },
        },
        async ({ flowName, input, runId }) => {
          const flow = this.headDef.flows.get(flowName);
          if (!flow) {
            throw new Error(`Flow "${flowName}" is not registered on Head`);
          }
          const assignedRunId = runId ?? `run-${randomUUID()}`;
          const controller = new AbortController();
          this.activeRunControllers.set(assignedRunId, controller);

          void this.engine
            .run(flow, input ?? {}, {
              runId: assignedRunId,
              hookServerUrl: this.url,
              signal: controller.signal,
              onActivePluginsChange: (rId, plugins, workDir, customTools) => {
                this.registerRunPlugins(rId, plugins, workDir, customTools);
              },
            })
            .catch(() => undefined)
            .finally(() => {
              this.activeRunControllers.delete(assignedRunId);
              this.unregisterRunPlugins(assignedRunId);
            });
          return this.formatMcpResult({ started: true, runId: assignedRunId });
        },
      );

      server.registerTool(
        'workflow_pause',
        {
          description: 'Pause an active workflow run and place it into blocked status',
          inputSchema: {
            runId: z.string(),
            reason: z.string().optional(),
          },
        },
        async ({ runId, reason }) => {
          void this.store.haltRun(runId, reason ?? 'Paused by Head');
          return this.formatMcpResult({ paused: true, runId });
        },
      );

      server.registerTool(
        'workflow_cancel',
        {
          description: 'Cancel an active workflow run and abort in-flight subprocesses',
          inputSchema: { runId: z.string() },
        },
        async ({ runId }) => {
          this.store.updateRunProgress(runId, {
            status: 'cancelled',
            finishedAtMs: Date.now(),
          });
          const ctrl = this.activeRunControllers.get(runId);
          if (ctrl) {
            ctrl.abort();
            this.activeRunControllers.delete(runId);
          }
          this.store.releaseRunLeases(runId);
          return this.formatMcpResult({ cancelled: true, runId });
        },
      );
    }

    if (caps.has('blockers:resolve')) {
      server.registerTool(
        'blocker_list',
        {
          description: 'List all currently blocked workflow runs',
          inputSchema: {},
        },
        async () =>
          this.formatMcpResult({
            blocked: this.store.listRuns().filter((r) => r.status === 'blocked'),
          }),
      );

      server.registerTool(
        'blocker_resolve',
        {
          description: 'Resolve a blocked workflow run and resume its execution',
          inputSchema: {
            runId: z.string(),
            resolution: z.any(),
          },
        },
        async ({ runId, resolution }) => {
          const resolved = this.store.resolveBlocker(runId, resolution);
          return this.formatMcpResult({ resolved, runId });
        },
      );
    }

    if (caps.has('tickets:read')) {
      server.registerTool(
        'ticket_list',
        {
          description: 'List all tickets in .harness/tickets/*.md',
          inputSchema: {},
        },
        async () => this.formatMcpResult({ tickets: this.store.listTickets() }),
      );

      server.registerTool(
        'ticket_read',
        {
          description: 'Read a ticket markdown file by ID',
          inputSchema: { id: z.string() },
        },
        async ({ id }) => this.formatMcpResult({ ticket: this.store.readTicket(id) }),
      );
    }

    if (caps.has('tickets:write')) {
      server.registerTool(
        'ticket_write',
        {
          description: 'Create or update a ticket markdown file in .harness/tickets/',
          inputSchema: {
            id: z.string(),
            title: z.string().optional(),
            status: z.string().optional(),
            touches: z.array(z.string()).optional(),
            body: z.string().optional(),
            frontmatter: z.record(z.string(), z.unknown()).optional(),
          },
        },
        async (args) => {
          const fm: Record<string, unknown> = { ...(args.frontmatter ?? {}) };
          if (args.title !== undefined) fm.title = args.title;
          if (args.status !== undefined) fm.status = args.status;
          if (args.touches !== undefined) fm.touches = args.touches;
          const ticket = this.store.writeTicket(args.id, fm, args.body ?? "");
          return this.formatMcpResult({ ticket });
        },
      );
    }

    if (caps.has('lessons:manage')) {
      server.registerTool(
        'lesson_list',
        {
          description: 'List all lessons in .harness/lessons.jsonl',
          inputSchema: {},
        },
        async () => this.formatMcpResult({ lessons: this.store.listLessons() }),
      );

      server.registerTool(
        'lesson_add',
        {
          description: 'Add a scoped lesson to .harness/lessons.jsonl',
          inputSchema: {
            kind: z.enum(['domain', 'behavioral']),
            roles: z.array(z.string()),
            paths: z.array(z.string()),
            rule: z.string(),
          },
        },
        async (args) => {
          const added = this.store.addLesson(args);
          return this.formatMcpResult({ lesson: added });
        },
      );

      server.registerTool(
        'lesson_widen',
        {
          description: 'Update or widen an existing lesson in .harness/lessons.jsonl',
          inputSchema: {
            id: z.string(),
            roles: z.array(z.string()).optional(),
            paths: z.array(z.string()).optional(),
            rule: z.string().optional(),
          },
        },
        async ({ id, roles, paths, rule }) => {
          const updated = this.store.widenLesson(id, { roles, paths, rule });
          return this.formatMcpResult({ lesson: updated });
        },
      );

      server.registerTool(
        'lesson_remove',
        {
          description: 'Remove a lesson by ID from .harness/lessons.jsonl',
          inputSchema: { id: z.string() },
        },
        async ({ id }) => {
          const removed = this.store.removeLesson(id);
          return this.formatMcpResult({ removed, id });
        },
      );
    }

    if (caps.has('accounts:manage')) {
      server.registerTool(
        'account_status',
        {
          description: 'Inspect account pool utilization and quota shares',
          inputSchema: {},
        },
        async () => this.formatMcpResult({ quotas: this.store.listAccountQuotas() }),
      );

      server.registerTool(
        'account_set_share',
        {
          description: 'Set or override the project quota share ceiling for an account',
          inputSchema: {
            accountId: z.string(),
            maxShare: z.number().min(0).max(1),
          },
        },
        async ({ accountId, maxShare }) => {
          this.store.setAccountShareOverride(accountId, maxShare);
          return this.formatMcpResult({ accountId, maxShare });
        },
      );
    }

    if (caps.has('telemetry:read')) {
      server.registerTool(
        'telemetry_summary',
        {
          description: 'Read invocation telemetry and cost breakdown',
          inputSchema: { runId: z.string().optional() },
        },
        async ({ runId }) => {
          const list = this.store.listInvocations(runId);
          const equivalent = sumCosts(list.map((i) => i.equivalentCostUsd));
          return this.formatMcpResult({
            actualCostUsd: sumCosts(list.map((i) => i.actualCostUsd)).usd,
            equivalentCostUsd: equivalent.usd,
            unpricedInvocations: equivalent.unpriced,
            invocations: list,
          });
        },
      );

      server.registerTool(
        'telemetry_runs',
        {
          description: 'Read per-run telemetry and token/cost breakdown',
          inputSchema: {},
        },
        async () => {
          const runs = this.store.listRuns().map((r) => {
            const invs = this.store.listInvocations(r.id);
            const equivalent = sumCosts(invs.map((i) => i.equivalentCostUsd));
            return {
              runId: r.id,
              flowName: r.flowName,
              status: r.status,
              iterations: r.iteration + 1,
              invocations: invs.length,
              inputTokens: invs.reduce((s, i) => s + i.inputTokens, 0),
              cachedInputTokens: invs.reduce((s, i) => s + i.cachedInputTokens, 0),
              outputTokens: invs.reduce((s, i) => s + i.outputTokens, 0),
              actualCostUsd: sumCosts(invs.map((i) => i.actualCostUsd)).usd,
              equivalentCostUsd: equivalent.usd,
              unpricedInvocations: equivalent.unpriced,
            };
          });
          return this.formatMcpResult({ runs });
        },
      );
    }

    if (caps.has('runner:exec')) {
      server.registerTool(
        'runner_exec',
        {
          description: 'Execute a command via the local runner',
          inputSchema: {
            command: z.string(),
            cwd: z.string().optional(),
            timeoutMs: z.number().optional(),
          },
        },
        async ({ command, cwd, timeoutMs }) => {
          const runner = new LocalRunner();
          const res = await runner.exec(command, {
            cwd: cwd ?? this.store.projectDir,
            timeoutMs: timeoutMs ?? 60_000,
            reject: false,
          });
          return this.formatMcpResult({
            exitCode: res.exitCode,
            stdout: res.stdout,
            stderr: res.stderr,
            durationMs: res.durationMs,
          });
        },
      );
    }

    const mergedCustomTools = new Map<string, Executable<any, any>>(this.headDef.customTools);
    for (const active of this.activeRunPlugins.values()) {
      if (active.customTools) {
        for (const [k, v] of active.customTools.entries()) {
          if (!mergedCustomTools.has(k)) {
            mergedCustomTools.set(k, v);
          }
        }
      }
    }

    for (const [toolName, executable] of mergedCustomTools.entries()) {
      const shape =
        executable.inputSchema instanceof z.ZodObject
          ? (executable.inputSchema as z.ZodObject<any>).shape
          : { input: executable.inputSchema };

      server.registerTool(
        toolName,
        {
          description: `Custom harness executable tool: ${executable.name}`,
          inputSchema: shape,
        },
        async (args: Record<string, unknown>) => {
          const unwrapped =
            executable.inputSchema instanceof z.ZodObject ? args : (args.input ?? args);
          const execCtx: ExecutionContext = {
            runId: `head-tool-${randomUUID()}`,
            iteration: 0,
            stepName: toolName,
            projectDir: this.store.projectDir,
            workDir: this.store.projectDir,
            slotIndex: 0,
            slotPorts: [18000, 18001, 18002],
            touchedPaths: [],
            store: this.store,
            hookServerUrl: this.url,
            signal: new AbortController().signal,
          };
          const out = await executable.execute(unwrapped, execCtx);
          return this.formatMcpResult({ result: out });
        },
      );
    }

    return server;
  }

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsedUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

    if (parsedUrl.pathname === HOOK_PATH && req.method === 'POST') {
      const bodyText = await this.readBody(req);
      let payload: Record<string, unknown> = {};
      if (bodyText.trim().length > 0) {
        try {
          payload = JSON.parse(bodyText) as Record<string, unknown>;
        } catch (err) {
          void err;
        }
      }
      const responseJson = await this.handleHookCallback(
        parsedUrl.searchParams.get('protocol'),
        parsedUrl.searchParams.get('runId') ?? '',
        payload,
      );
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(responseJson));
      return;
    }

    if (parsedUrl.pathname === '/mcp') {
      const bodyText = req.method === 'POST' ? await this.readBody(req) : undefined;
      const parsedBody = bodyText ? JSON.parse(bodyText) : undefined;
      const mcpServer = this.buildMcpServerInstance();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  public async handleHookCallback(
    protocolName: string | null,
    runId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const protocol = protocolName
      ? this.headDef.hookProtocols.get(protocolName)
      : this.headDef.hookProtocols.values().next().value;
    const event = protocol?.parse(payload);
    if (!protocol || !event) return {};

    const tokens = event.contextTokens ?? 0;
    if (runId.length > 0) {
      if (tokens > 0) this.store.setRunContextTokens(runId, tokens);
    } else {
      if (tokens > 0) {
        this.store.upsertHeadSession({
          sessionId: event.sessionId ?? 'head-session',
          transcriptPath: event.transcriptPath,
          contextTokens: tokens,
        });
      }
      if (tokens >= this.headDef.contextNoticeThresholdTokens) {
        return protocol.formatDecision(event, {
          allow: true,
          additionalContext: `Head context usage (${tokens} tokens) crossed threshold (${this.headDef.contextNoticeThresholdTokens}). Call harness_handoff({ note }) and compact or rotate.`,
        });
      }
    }

    const active = this.activeRunPlugins.get(runId);
    const ctx = { runId, store: this.store, workDir: active?.workDir ?? this.store.projectDir };
    for (const plugin of active?.plugins ?? []) {
      const handler =
        event.phase === 'pre-tool'
          ? event.intent !== null && plugin.preTool?.intents.includes(event.intent)
            ? plugin.preTool
            : undefined
          : event.phase === 'stop'
            ? plugin.stop
            : undefined;
      if (!handler) continue;
      const decision = await handler.handle(event, ctx);
      if (!decision.allow) {
        return protocol.formatDecision(event, {
          allow: false,
          reason: decision.reason ?? `Blocked by ${plugin.name}`,
        });
      }
    }
    return protocol.formatDecision(event, { allow: true });
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk: Buffer) => {
        data += chunk.toString('utf8');
      });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
  }
}

export async function startOrchestrator(opts: {
  readonly projectDir: string;
  readonly head: HeadDef;
  readonly port?: number;
}): Promise<{
  readonly store: HarnessStore;
  readonly engine: FlowEngine;
  readonly mcpServer: HarnessMcpServer;
  readonly port: number;
  readonly mcpUrl: string;
  readonly close: () => Promise<void>;
}> {
  const { HarnessStore: StoreCls } = await import('./store.js');
  const store = new StoreCls(opts.projectDir);
  const engine = new FlowEngine(store);
  const mcpServer = new HarnessMcpServer(opts.head, store, engine);
  const { port, mcpUrl } = await mcpServer.start(opts.port);

  return {
    store,
    engine,
    mcpServer,
    port,
    mcpUrl,
    close: async () => {
      await mcpServer.stop();
      store.close();
    },
  };
}
