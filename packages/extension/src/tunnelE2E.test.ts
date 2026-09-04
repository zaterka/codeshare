import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, type RunningServer } from '@codeshare/host';
import { startTunnel, type RunningTunnel } from './tunnel.js';

/**
 * End-to-end test against the REAL `cloudflared` binary and the real Cloudflare edge.
 *
 * Opt-in (`CODESHARE_E2E=1`) because it is the one test that needs network access and that briefly
 * publishes a folder to the public internet. It exists because the stub-driven tests in
 * `tunnel.test.ts` cannot catch the failure that actually matters in production: cloudflared
 * changing the shape of the banner we scrape the hostname out of.
 *
 * Scope of exposure while it runs: a fresh temp directory holding one dummy file, behind a random
 * session code, for a few seconds. Nothing from the repo is shared.
 */

const ENABLED = process.env.CODESHARE_E2E === '1';
const CODE = String(Math.floor(100000 + Math.random() * 900000));

describe.runIf(ENABLED)('cloudflared end-to-end', () => {
  let root: string;
  let server: RunningServer;
  let tunnel: RunningTunnel;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'codeshare-e2e-'));
    await fs.writeFile(path.join(root, 'seed.txt'), 'hello from the host\n', 'utf8');
    server = await startServer({ root, port: 0, sessionCode: CODE, host: '127.0.0.1' });
    tunnel = await startTunnel(server.port);
  }, 60_000);

  afterAll(async () => {
    await tunnel?.close().catch(() => {});
    await server?.close().catch(() => {});
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it('publishes a trycloudflare hostname', () => {
    expect(tunnel.origin).toMatch(/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/);
  });

  it('serves MCP tools through the public URL and writes to the host folder', async () => {
    const url = new URL(`${tunnel.origin}/codeshare`);

    // A freshly published quick tunnel takes a moment to become routable at the edge; retry rather
    // than assert on the first attempt.
    let client: Client | undefined;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const transport = new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { Authorization: `Bearer ${CODE}` } },
        });
        const c = new Client({ name: 'codeshare-e2e', version: '0.1.0' });
        await c.connect(transport);
        client = c;
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    if (!client) throw new Error(`never became reachable: ${String(lastErr)}`);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('codeshare_write_file');

    // Read the seeded file, then write a new one, and confirm it landed on the host's disk.
    const read = await client.callTool({
      name: 'codeshare_read_file',
      arguments: { path: 'seed.txt' },
    });
    expect(JSON.stringify(read)).toContain('hello from the host');

    await client.callTool({
      name: 'codeshare_write_file',
      arguments: { path: 'from-guest.txt', content: 'written through the tunnel' },
    });
    const onDisk = await fs.readFile(path.join(root, 'from-guest.txt'), 'utf8');
    expect(onDisk).toBe('written through the tunnel');

    await client.close();
  }, 90_000);

  it('rejects a wrong session code through the public URL', async () => {
    const resp = await fetch(`${tunnel.origin}/codeshare`, {
      method: 'POST',
      headers: { Authorization: 'Bearer 000000', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(resp.status).toBe(401);
  }, 30_000);
});
