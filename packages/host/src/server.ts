import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { safeEqual, type RunningServer, type ServerOptions } from '@codeshare/shared';
import { registerTools } from './tools.js';

const DEFAULT_IGNORED = ['.git', 'node_modules'];

const ENDPOINT_PATH = '/codeshare';

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  mcpServer: McpServer;
}

interface ClientMessage {
  jsonrpc: '2.0';
  method?: string;
  id?: unknown;
  params?: unknown;
}

/** Read and JSON-parse a request body, returning null if it isn't valid JSON. */
async function readJsonBody(req: IncomingMessage): Promise<ClientMessage | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    if (chunks.reduce((n, c) => n + c.length, 0) > 10 * 1024 * 1024) {
      throw new Error('Request body too large');
    }
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ClientMessage;
  } catch {
    return null;
  }
}

/**
 * Start an authenticated MCP server exposing `root` over the network.
 *
 * The server runs a *per-client-session transport router*: because the SDK's
 * `StreamableHTTPServerTransport` is single-session per instance, we mint a new transport + McpServer
 * for each authenticated MCP client that sends an `initialize`, and route subsequent requests by
 * `mcp-session-id`. This lets the host AI and guest AI coexist as independent sessions.
 *
 * Every request must carry `Authorization: Bearer <sessionCode>`.
 */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const root = await import('node:fs/promises').then((fs) => fs.realpath(options.root));
  const sessionCode = options.sessionCode;
  const maxFileSizeBytes = options.maxFileSizeBytes ?? 10 * 1024 * 1024;
  const ignoredDirs = options.ignoredDirs ?? DEFAULT_IGNORED;
  const host = options.host ?? '0.0.0.0';

  const sessions = new Map<string, SessionEntry>();
  const listeners = new Set<(ids: ReadonlyArray<string>) => void>();

  function emitSessions() {
    const ids = [...sessions.keys()];
    for (const cb of listeners) cb(ids);
  }

  function newMcpServer(): McpServer {
    const server = new McpServer(
      { name: 'codeshare', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );
    registerTools(server, { root, maxFileSizeBytes, ignoredDirs });
    return server;
  }

  function createSession(): SessionEntry {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, entry);
        emitSessions();
      },
      onsessionclosed: async (id) => {
        const existing = sessions.get(id);
        if (existing) {
          sessions.delete(id);
          emitSessions();
          await existing.mcpServer.close().catch(() => {});
        }
      },
    });
    const mcpServer = newMcpServer();
    const entry = { transport, mcpServer };
    return entry;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 1) Route: only the configured endpoint is served.
    const url = req.url ?? '/';
    const pathname = url.split('?')[0] ?? '/';
    if (pathname !== ENDPOINT_PATH) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // 2) Auth: constant-time compare of the bearer token.
    const auth = req.headers.authorization ?? '';
    const expected = `Bearer ${sessionCode}`;
    if (!safeEqual(auth.trim(), expected)) {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer',
      });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    // 3) Session routing.
    const sessionId = Array.isArray(req.headers['mcp-session-id'])
      ? req.headers['mcp-session-id'][0]
      : req.headers['mcp-session-id'];

    if (sessionId) {
      const entry = sessions.get(sessionId);
      if (!entry) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unknown session' }));
        return;
      }
      // Non-initialize requests carry a body for POST; GET/DELETE have none. Passing an undefined
      // parsedBody lets handleRequest read the stream itself for POST.
      let parsedBody: unknown;
      if (req.method === 'POST') {
        try {
          parsedBody = await readJsonBody(req);
        } catch {
          res.writeHead(413);
          res.end();
          return;
        }
      }
      await entry.transport.handleRequest(req, res, parsedBody);
      return;
    }

    // 4) No session id yet -> must be an `initialize` POST.
    if (req.method !== 'POST') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad request: missing session id' }));
      return;
    }
    let body: ClientMessage | null;
    try {
      body = await readJsonBody(req);
    } catch {
      res.writeHead(413);
      res.end();
      return;
    }
    if (!body || body.method !== 'initialize') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad request: expected initialize' }));
      return;
    }

    const entry = createSession();
    await entry.mcpServer.connect(entry.transport);
    await entry.transport.handleRequest(req, res, body);
  }

  const requestListener = (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((err) => {
      // Best-effort error response for the current request.
      if (!res.writableEnded) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Internal error: ${(err as Error).message}` }));
      }
    });
  };

  const server: HttpServer = options.cert
    ? https.createServer({ cert: options.cert.cert, key: options.cert.key }, requestListener)
    : http.createServer(requestListener);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, () => resolve());
  });

  const scheme = options.cert ? 'https' : 'http';
  const port = (server.address() as { port: number }).port;

  return {
    // Loopback is the one address that is always correct for the machine we run on. A `0.0.0.0`
    // bind has no single public name, so we deliberately do not invent one here — deriving a
    // guest-reachable URL (tunnel hostname, LAN IP, reverse proxy) is the caller's job.
    localUrl: `${scheme}://127.0.0.1:${port}${ENDPOINT_PATH}`,
    port,
    get connectedSessions() {
      return [...sessions.keys()];
    },
    onSessionChange(cb) {
      listeners.add(cb);
      return;
    },
    async close() {
      await Promise.all(
        [...sessions.values()].map(async (entry) => {
          await entry.mcpServer.close().catch(() => {});
          await entry.transport.close().catch(() => {});
        }),
      );
      sessions.clear();
      listeners.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export type { RunningServer };
// Re-exported for the CLI / extension boundary.
export { ENDPOINT_PATH };

// Referenced to keep JSONRPCMessage typing coherent if used downstream.
export type { JSONRPCMessage };
