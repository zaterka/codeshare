import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Agent } from 'undici';

export interface VerifyOptions {
  url: string;
  sessionCode: string;
  /** When true, skip TLS certificate validation (for LAN/dev against a self-signed host). */
  insecure?: boolean;
  /** Timeout (ms) for the verification calls. Default 8000. */
  timeoutMs?: number;
}

export interface VerifyResult {
  ok: boolean;
  tools: string[];
  serverName: string;
  reason: 'auth' | 'unreachable' | 'ok';
}

/**
 * A `fetch` that disables TLS certificate validation (self-signed LAN/dev hosts). It delegates to the
 * native fetch and only injects an undici dispatcher with `rejectUnauthorized: false`, so streaming
 * (SSE), headers and bodies behave exactly like the native client. The session code is the shared
 * secret; TLS integrity is a bonus, not the auth in this dev path.
 */
function buildInsecureFetch(): typeof fetch {
  const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  return (input, init) => fetch(input, { ...init, dispatcher } as unknown as RequestInit);
}

/**
 * Verify that a remote codeshare MCP endpoint is reachable and authenticated, listing its tools.
 */
export async function verifyRemote(options: VerifyOptions): Promise<VerifyResult> {
  const url = new URL(options.url);
  const timeoutMs = options.timeoutMs ?? 8000;

  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: { Authorization: `Bearer ${options.sessionCode}` },
    },
    fetch: options.insecure ? buildInsecureFetch() : undefined,
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 100,
      maxReconnectionDelay: 100,
      reconnectionDelayGrowFactor: 1,
    },
  });
  const client = new Client({ name: 'codeshare-guest', version: '0.1.0' });

  // Enforce the timeout on every awaited step (connect AND listTools), so a slow-but-responsive
  // host can't hang the guest's busy indicator past the deadline.
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const giveUp = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error('Verification timed out'));
    }, timeoutMs);
    timer.unref?.();
  });
  const raced = async <T,>(p: Promise<T>): Promise<T> => {
    const winner = await Promise.race([p, giveUp]);
    return winner as T;
  };

  try {
    await raced(client.connect(transport));
    const { tools } = await raced(
      client.listTools().catch(() => ({ tools: [] as Array<{ name: string }> })),
    );
    clearTimeout(timer);
    await client.close().catch(() => {});
    return { ok: true, tools: tools.map((t) => t.name), serverName: 'codeshare', reason: 'ok' };
  } catch (err) {
    clearTimeout(timer);
    await client.close().catch(() => {});
    if (timedOut) return { ok: false, tools: [], serverName: '', reason: 'unreachable' };
    const message = (err as Error).message;
    const reason: VerifyResult['reason'] = /401|Unauthorized|Not authorized/i.test(message) ? 'auth' : 'unreachable';
    return { ok: false, tools: [], serverName: '', reason };
  }
}
