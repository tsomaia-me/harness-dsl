import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ControlError } from '../../engine/control.js';
import { readBody } from '../../engine/guards.js';
import type { Client, ClientEndpoint, ControlApi, Grant } from '../../kernel/backends.js';
import type { EnvRef, Json, PortRef, Resolver } from '../../kernel/refs.js';

export interface HttpControlApiOptions {
  readonly port: number | PortRef;
  readonly token: EnvRef;
  readonly grants: readonly Grant[];
}

function reply(res: ServerResponse, status: number, body: Json): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * The control API over HTTP on the loopback interface: `GET /operations`, `POST /operations/<name>`
 * with a JSON body, and `GET /events` as a server-sent stream; every request carries the bearer token.
 */
export class HttpControlApiClient implements Client {
  public readonly entity = 'client' as const;
  public readonly name: string;
  public readonly grants: readonly Grant[];
  public readonly endpoint: ClientEndpoint;
  private server: Server | undefined;
  private origin: string | undefined;

  public constructor(
    name: string,
    private readonly options: HttpControlApiOptions,
  ) {
    this.name = name;
    this.grants = options.grants;
    this.endpoint = { transport: 'http', ...(typeof options.port === 'number' ? {} : { port: options.port }) };
  }

  /** The origin the client serves at; known once `serve` has bound the port. */
  public url(): string {
    if (!this.origin) throw new Error(`client "${this.name}" is not serving`);
    return this.origin;
  }

  public async serve(api: ControlApi, resolver: Resolver): Promise<{ stop(): Promise<void> }> {
    const token = resolver.env(this.options.token);
    const port = typeof this.options.port === 'number' ? this.options.port : resolver.port(this.options.port);
    const server = createServer((req, res) => {
      this.handle(api, token, req, res).catch((err: unknown) => {
        if (!res.headersSent) reply(res, 500, { error: err instanceof Error ? err.message : String(err) });
        else res.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
    this.server = server;
    this.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
      stop: async () => {
        this.origin = undefined;
        this.server = undefined;
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  private async handle(api: ControlApi, token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.headers.authorization !== `Bearer ${token}`) {
      reply(res, 401, { error: 'a bearer token is required' });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/operations') {
      reply(res, 200, { operations: api.operations() });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': connected\n\n');
      const unsubscribe = api.subscribe((event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      });
      req.on('close', unsubscribe);
      return;
    }
    const match = /^\/operations\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'POST' && match) {
      const body = await readBody(req);
      let input: Json;
      try {
        input = body.trim() ? (JSON.parse(body) as Json) : {};
      } catch {
        reply(res, 400, { error: 'the body is not JSON' });
        return;
      }
      try {
        reply(res, 200, await api.call(decodeURIComponent(match[1]!), input, this.name));
      } catch (err) {
        reply(res, err instanceof ControlError ? err.status : 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    reply(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
  }
}

export const http = {
  controlApi(name: string, options: HttpControlApiOptions): HttpControlApiClient {
    return new HttpControlApiClient(name, options);
  },
};
