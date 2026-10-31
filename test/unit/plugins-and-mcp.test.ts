import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { type AgentPlugin, claudeCodeHookProtocol, H, HarnessStore, startOrchestrator, z } from '../../src/index.js';
import {
  fileLeaseGuard,
  gitWorktreeIsolation,
  stopCommandHook,
} from '../../src/plugins/index.js';

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('First-Party Plugins & Head MCP Server', () => {
  const tempDirs: string[] = [];

  function makeGitRepo(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'harness-git-plugin-'));
    tempDirs.push(dir);
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    writeFileSync(path.join(dir, 'index.ts'), 'export const x = 1;\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates an isolated git worktree per flow run and cleans it up on completion', async () => {
    const repoDir = makeGitRepo();
    const head = H.head().port(0);
    const orch = await startOrchestrator({ projectDir: repoDir, head });

    let observedWorkDir = '';
    const TouchCmd = H.command('touch-worktree')
      .input(z.any())
      .output(z.object({ branch: z.string() }))
      .run(async ({ ctx, exec }) => {
        observedWorkDir = ctx.workDir;
        writeFileSync(path.join(ctx.workDir, 'feature.ts'), 'export const feat = true;\n', 'utf8');
        const branchRes = await exec('git rev-parse --abbrev-ref HEAD', { cwd: ctx.workDir });
        return { branch: branchRes.stdout.trim() };
      });

    const flow = H.flow('wt-flow')
      .input(z.object({ id: z.string() }))
      .use(gitWorktreeIsolation({ baseBranch: 'main', cleanupOnSuccess: true }))
      .step('touch', TouchCmd);

    const res = await orch.engine.run(flow, { id: 'T-900' }, { runId: 'run-wt-1' });
    expect.soft(res.steps.touch.branch).toBe('harness/run-wt-1');
    expect.soft(observedWorkDir).toContain('run-wt-1');
    expect.soft(existsSync(path.join(repoDir, 'feature.ts'))).toBe(false);
    expect.soft(existsSync(observedWorkDir)).toBe(false);

    await orch.close();
  });

  it('blocks Stop by a custom verdict on a command whose output is not { passed, summary }', async () => {
    const repoDir = makeGitRepo();
    const store = new HarnessStore(repoDir);
    const Lint = H.command('lint')
      .input(z.object({ dir: z.string() }))
      .output(z.object({ exitCode: z.number(), log: z.string() }))
      .run(({ input }) => ({ exitCode: 2, log: `3 errors in ${path.basename(input.dir)}` }));
    const hook = stopCommandHook(Lint, {
      mapInput: ({ workDir }) => ({ dir: workDir }),
      verdict: (out) => ({ allow: out.exitCode === 0, reason: out.log }),
    });
    const event = { phase: 'stop', intent: null, filePaths: [], raw: {} } as const;
    await expect(hook.stop!.handle(event, { runId: 'run-L', store, workDir: repoDir })).resolves.toEqual({
      allow: false,
      reason: `3 errors in ${path.basename(repoDir)}`,
    });
    store.close();
  });

  it('serves Head MCP tools, enforces fileLeaseGuard and stopCommandHook even when agent transcript_path is high, and resolves halted runs', async () => {
    const repoDir = makeGitRepo();

    const CheckCmd = H.command('verify-ready')
      .input(z.any())
      .output(z.object({ passed: z.boolean(), summary: z.string() }))
      .run(async ({ ctx }) => {
        const readyFile = path.join(ctx.workDir, 'ready.txt');
        if (!existsSync(readyFile)) {
          return { passed: false, summary: 'Missing ready.txt' };
        }
        return { passed: true, summary: 'All green' };
      });

    const ExploreSkill = H.skill('explore')
      .input(z.object({ query: z.string() }))
      .output(z.object({ answer: z.string() }));

    const Explorer = H.agent('explorer').model(
      H.model(
        H.account(
          'exp-mock',
          H.drivers.mock({
            handler: async (req) => ({
              structuredOutput: { answer: `Explored: ${req.userPrompt}` },
            }),
          }),
        ),
        'claude-haiku-4-5',
      ),
    );

    const PauseFlow = H.flow('pause-flow')
      .input(z.object({ question: z.string() }))
      .haltIf(
        () => true,
        (ctx) => ({ reason: ctx.input.question }),
      )
      .step(
        'after',
        H.command('done-cmd')
          .input(z.any())
          .output(z.object({ finished: z.boolean() }))
          .run(async () => ({ finished: true })),
      );

    const head = H.head()
      .port(0)
      .capabilities([
        'workflows:read',
        'workflows:control',
        'blockers:resolve',
        'tickets:read',
        'tickets:write',
        'lessons:manage',
        'accounts:manage',
        'telemetry:read',
        'runner:exec',
      ])
      .contextNoticeThreshold(100_000)
      .tool('explore_repo', Explorer.run(ExploreSkill))
      .registerFlow(PauseFlow);

    const orch = await startOrchestrator({ projectDir: repoDir, head });
    expect.soft(existsSync(path.join(repoDir, '.mcp.json'))).toBe(true);

    const registerPlugins = (runId: string, plugins: AgentPlugin[]) =>
      orch.mcpServer.register(runId, {
        runId,
        workDir: repoDir,
        protocol: claudeCodeHookProtocol,
        plugins,
        customTools: new Map(),
      });
    registerPlugins('run-A', [fileLeaseGuard(), stopCommandHook(CheckCmd)]);
    registerPlugins('run-B', [fileLeaseGuard()]);

    const agentTranscriptPath = path.join(repoDir, 'agent-transcript.jsonl');
    writeFileSync(
      agentTranscriptPath,
      JSON.stringify({
        type: 'assistant',
        message: {
          usage: {
            input_tokens: 150_000,
            cache_read_input_tokens: 40_000,
            output_tokens: 5_000,
          },
        },
      }) + '\n',
      'utf8',
    );

    const preRes1 = await fetch(`${orch.mcpServer.url}/internal/hook?invocation=run-A`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: 'PreToolUse',
        transcript_path: agentTranscriptPath,
        tool_name: 'Edit',
        tool_input: { file_path: path.join(repoDir, 'apps/edge/wallet.ts') },
      }),
    }).then((r) => r.json() as Promise<Record<string, any>>);
    expect.soft(preRes1).toStrictEqual({});
    expect.soft(orch.store.getRunContextTokens('run-A')).toBe(195_000);
    expect.soft(orch.store.getActiveHeadSession()).toBeNull();

    const preRes2 = await fetch(`${orch.mcpServer.url}/internal/hook?invocation=run-B`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: 'PreToolUse',
        transcript_path: agentTranscriptPath,
        tool_name: 'Edit',
        tool_input: { file_path: path.join(repoDir, 'apps/edge/wallet.ts') },
      }),
    }).then((r) => r.json() as Promise<Record<string, any>>);
    expect.soft(preRes2.hookSpecificOutput?.permissionDecision).toBe('deny');

    const stopBlocked = await fetch(`${orch.mcpServer.url}/internal/hook?invocation=run-A`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hook_event_name: 'Stop', transcript_path: agentTranscriptPath }),
    }).then((r) => r.json() as Promise<Record<string, any>>);
    expect.soft(stopBlocked).toEqual({
      decision: 'block',
      reason: 'Missing ready.txt',
    });

    writeFileSync(path.join(repoDir, 'ready.txt'), 'ok', 'utf8');
    const stopAllowed = await fetch(`${orch.mcpServer.url}/internal/hook?invocation=run-A`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hook_event_name: 'Stop' }),
    }).then((r) => r.json() as Promise<Record<string, any>>);
    expect.soft(stopAllowed).toStrictEqual({});

    const transcriptPath = path.join(repoDir, 'head-transcript.jsonl');
    writeFileSync(
      transcriptPath,
      JSON.stringify({
        type: 'assistant',
        message: {
          usage: {
            input_tokens: 95_000,
            cache_read_input_tokens: 20_000,
            output_tokens: 2_000,
          },
        },
      }) + '\n',
      'utf8',
    );

    const client = new Client({ name: 'test-head-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(orch.mcpUrl));
    await client.connect(transport);

    const groundRes = await client.callTool({
      name: 'harness_ground',
      arguments: { sessionId: 'head-1', transcriptPath },
    });
    const groundJson = JSON.parse(((groundRes.content as any)[0] as any).text);
    expect.soft(groundJson.contextTokens).toBe(117_000);
    expect.soft(groundJson.contextWarning).toContain('harness_handoff');

    const customToolRes = await client.callTool({
      name: 'explore_repo',
      arguments: { query: 'Where is auth?' },
    });
    const customJson = JSON.parse(((customToolRes.content as any)[0] as any).text);
    expect.soft(customJson.result.answer).toContain('Where is auth?');

    await client.callTool({
      name: 'ticket_write',
      arguments: {
        id: 'CD-777',
        title: 'Add ledger check',
        status: 'ready',
        frontmatter: { touches: ['apps/edge/**'] },
        body: 'Verify ledger balances.',
      },
    });
    const ticketListRes = await client.callTool({ name: 'ticket_list', arguments: {} });
    const ticketListJson = JSON.parse(((ticketListRes.content as any)[0] as any).text);
    expect.soft(ticketListJson.tickets.length).toBe(1);
    expect.soft(ticketListJson.tickets[0].id).toBe('CD-777');

    const ticketReadRes = await client.callTool({
      name: 'ticket_read',
      arguments: { id: 'CD-777' },
    });
    const ticketReadJson = JSON.parse(((ticketReadRes.content as any)[0] as any).text);
    expect.soft(ticketReadJson.ticket.content).toBe('Verify ledger balances.');

    await client.callTool({
      name: 'account_set_share',
      arguments: { accountId: 'claude-1', maxShare: 0.45 },
    });
    expect.soft(orch.store.getAccountShareOverride('claude-1')).toBe(0.45);

    const execRes = await client.callTool({
      name: 'runner_exec',
      arguments: { command: 'node -e "process.stdout.write(String(6 * 7))"' },
    });
    const execJson = JSON.parse(((execRes.content as any)[0] as any).text);
    expect.soft(execJson.stdout).toBe('42');

    await client.callTool({
      name: 'workflow_start',
      arguments: {
        flowName: 'pause-flow',
        runId: 'run-mcp-1',
        input: { question: 'Approve deploy?' },
      },
    });

    await waitFor(() => orch.store.getRun('run-mcp-1')?.status === 'blocked');
    const blockersRes = await client.callTool({
      name: 'blocker_list',
      arguments: {},
    });
    const blockersJson = JSON.parse(((blockersRes.content as any)[0] as any).text);
    expect.soft(blockersJson.blocked.length).toBe(1);
    expect.soft(blockersJson.blocked[0].id).toBe('run-mcp-1');

    await client.callTool({
      name: 'blocker_resolve',
      arguments: {
        runId: 'run-mcp-1',
        resolution: { approved: true },
      },
    });

    await waitFor(() => orch.store.getRun('run-mcp-1')?.status === 'completed');
    expect.soft(orch.store.getRun('run-mcp-1')?.status).toBe('completed');

    const telRunsRes = await client.callTool({
      name: 'telemetry_runs',
      arguments: {},
    });
    const telRunsJson = JSON.parse(((telRunsRes.content as any)[0] as any).text);
    expect.soft(telRunsJson.runs.some((r: any) => r.runId === 'run-mcp-1')).toBe(true);

    await client.close();
    await orch.close();
  });
});
