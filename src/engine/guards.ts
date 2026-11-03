import { realpathSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import picomatch from 'picomatch';
import type { Executable } from '../dsl/executables.js';
import type { GuardDecision, GuardEvent, GuardProtocol } from '../kernel/backends.js';
import type { JsonObject } from '../kernel/refs.js';

/** A stop check that keeps failing stops blocking after this many answers, so an agent cannot loop forever. */
export const MAX_CONSECUTIVE_STOP_BLOCKS = 3;

export interface GuardContext {
  readonly attemptId: string;
  readonly seat: string;
  readonly protocol: GuardProtocol;
  readonly workspacePath: string;
  readonly areas: Readonly<Record<string, readonly string[]>>;
  readonly leases: boolean;
  readonly beforeStop?: Executable<void, unknown>;
}

export interface GuardHost {
  takeLease(attemptId: string, resource: string): Promise<boolean>;
  runCheck(exec: Executable<void, unknown>, cwd: string): Promise<{ readonly ok: boolean; readonly detail: string }>;
}

/** The whole body of a request, as the hook server and the HTTP clients read it. */
/** The path with its symlinks resolved as far as it exists: a file not yet written resolves through its nearest existing parent. */
function realPath(target: string): string {
  let probe = target;
  const trailing: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(probe), ...trailing.reverse());
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return target;
      trailing.push(path.basename(probe));
      probe = parent;
    }
  }
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * Answers the hooks a guarded agent posts (design §4, `ModelDriver.hooks`): a write takes the lease of
 * the area it touches or is denied; a stop runs the step's check or is blocked with its output.
 */
export class GuardServer {
  private server: Server | undefined;
  private origin: string | undefined;
  private readonly guards = new Map<string, GuardContext>();
  private readonly blocks = new Map<string, number>();

  public constructor(
    private readonly host: GuardHost,
    private readonly port: number,
  ) {}

  public async start(): Promise<string> {
    const server = createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json' });
          res.end('{}');
          return;
        }
        const body = await readBody(req);
        let payload: JsonObject;
        try {
          payload = body.trim() ? (JSON.parse(body) as JsonObject) : {};
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'the hook payload is not JSON' }));
          return;
        }
        const answer = await this.handle(url.searchParams.get('invocation'), payload);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer));
      })().catch((err: unknown) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', () => resolve());
    });
    this.server = server;
    this.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return this.origin;
  }

  public async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    this.origin = undefined;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  public endpoint(): string {
    if (!this.origin) throw new Error('the hook server is not running');
    return this.origin;
  }

  public register(invocation: string, context: GuardContext): void {
    this.guards.set(invocation, context);
  }

  public unregister(invocation: string): void {
    this.guards.delete(invocation);
    this.blocks.delete(invocation);
  }

  public async handle(invocation: string | null, payload: JsonObject): Promise<JsonObject> {
    const context = invocation ? this.guards.get(invocation) : undefined;
    if (!invocation || !context) return {};
    const event = context.protocol.parse(payload);
    if (!event) return {};
    const decision = await this.decide(invocation, context, event);
    return context.protocol.formatDecision(event, decision);
  }

  /** The area a path falls in; both paths are resolved through their symlinks, since an agent reports real paths. */
  private areaOf(context: GuardContext, filePath: string): string | undefined {
    const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(context.workspacePath, filePath);
    const relative = path.relative(realPath(context.workspacePath), realPath(absolute)).split(path.sep).join('/');
    for (const [resource, globs] of Object.entries(context.areas)) {
      if (picomatch.isMatch(relative, [...globs])) return resource;
    }
    return undefined;
  }

  private async decide(invocation: string, context: GuardContext, event: GuardEvent): Promise<GuardDecision> {
    if (event.phase === 'pre-tool') {
      if (!context.leases) return { allow: true };
      for (const filePath of event.filePaths) {
        const resource = this.areaOf(context, filePath);
        if (!resource) continue;
        if (!(await this.host.takeLease(context.attemptId, resource))) {
          return { allow: false, reason: `"${filePath}" is in area "${resource}", which another attempt holds; work in a free area or wait` };
        }
      }
      return { allow: true };
    }
    if (!context.beforeStop) return { allow: true };
    const check = await this.host.runCheck(context.beforeStop, context.workspacePath);
    if (check.ok) {
      this.blocks.delete(invocation);
      return { allow: true };
    }
    const blocks = (this.blocks.get(invocation) ?? 0) + 1;
    if (blocks > MAX_CONSECUTIVE_STOP_BLOCKS) {
      this.blocks.delete(invocation);
      return { allow: true };
    }
    this.blocks.set(invocation, blocks);
    return { allow: false, reason: `check "${context.beforeStop.name}" failed: ${check.detail}` };
  }
}
