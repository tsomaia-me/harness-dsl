import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Client, ClientEndpoint, ControlApi, Grant } from '../../kernel/backends.js';
import type { Json, JsonObject, PortRef, Resolver } from '../../kernel/refs.js';

export interface SupervisorOptions {
  readonly grants: readonly Grant[];
  readonly port?: number | PortRef;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function toolName(operation: string): string {
  return operation.replace(/\./g, '_');
}

function objectSchema(schema: Json): { readonly schema: JsonObject; readonly wrapped: boolean } {
  const object = typeof schema === 'object' && schema !== null && !Array.isArray(schema) ? (schema as JsonObject) : {};
  if (object.type === 'object') return { schema: object, wrapped: false };
  return { schema: { type: 'object', properties: { input: schema }, required: ['input'] }, wrapped: true };
}

/**
 * A Claude Code session's view of the harness: the control API as MCP tools over streamable HTTP at
 * `/mcp`, one tool per granted operation, each named like the operation with underscores.
 */
export class SupervisorClient implements Client {
  public readonly entity = 'client' as const;
  public readonly name: string;
  public readonly grants: readonly Grant[];
  public readonly endpoint: ClientEndpoint;
  private server: Server | undefined;
  private origin: string | undefined;

  public constructor(
    name: string,
    private readonly options: SupervisorOptions,
  ) {
    this.name = name;
    this.grants = options.grants;
    this.endpoint = { transport: 'mcp', ...(typeof options.port === 'object' ? { port: options.port } : {}) };
  }

  /** The MCP endpoint the session connects to; known once `serve` has bound the port. */
  public url(): string {
    if (!this.origin) throw new Error(`supervisor "${this.name}" is not serving`);
    return `${this.origin}/mcp`;
  }

  private mcpServer(api: ControlApi): McpServer {
    const server = new McpServer({ name: `harness-${api.harness}`, version: '0.4.0' }, { capabilities: { tools: {} } });
    const tools = api.operations().map((operation) => ({ operation: operation.name, name: toolName(operation.name), ...objectSchema(operation.inputSchema) }));
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((tool) => ({ name: tool.name, description: `${tool.operation} on harness "${api.harness}"`, inputSchema: tool.schema as { type: 'object'; [key: string]: unknown } })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const tool = tools.find((candidate) => candidate.name === request.params.name);
      if (!tool) return { content: [{ type: 'text', text: `no tool "${request.params.name}"` }], isError: true };
      const args = (request.params.arguments ?? {}) as JsonObject;
      try {
        const result = await api.call(tool.operation, tool.wrapped ? (args.input as Json) : args, this.name);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    });
    return server;
  }

  public async serve(api: ControlApi, resolver: Resolver): Promise<{ stop(): Promise<void> }> {
    const port = this.options.port === undefined ? 0 : typeof this.options.port === 'number' ? this.options.port : resolver.port(this.options.port);
    const server = createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname !== '/mcp') {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }
        const body = req.method === 'POST' ? await readBody(req) : undefined;
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const mcp = this.mcpServer(api);
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      })().catch((err: unknown) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
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
}

export interface SessionOptions {
  readonly endpoints: readonly SupervisorClient[];
}

/** One Claude Code session over several harnesses: the MCP config naming every supervisor endpoint. */
export class SessionDef {
  public readonly entity = 'session' as const;

  public constructor(
    public readonly name: string,
    private readonly options: SessionOptions,
  ) {}

  public mcpConfig(resolver: Resolver): JsonObject {
    void resolver;
    return { mcpServers: Object.fromEntries(this.options.endpoints.map((endpoint) => [endpoint.name, { type: 'http', url: endpoint.url() }])) };
  }

  /** Writes `.mcp.json` into the directory the session is started from and returns its path. */
  public write(dir: string, resolver: Resolver): string {
    const file = path.join(dir, '.mcp.json');
    writeFileSync(file, `${JSON.stringify(this.mcpConfig(resolver), null, 2)}\n`, 'utf8');
    return file;
  }
}
