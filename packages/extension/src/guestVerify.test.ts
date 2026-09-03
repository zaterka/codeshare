import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { startServer } from '@codeshare/host';
import { verifyRemote } from './guestVerify.js';

const CODE = '123456';
let root: string | undefined;
const servers: Array<{ close(): Promise<void> }> = [];

afterAll(async () => {
  await Promise.all(servers.map((s) => s.close().catch(() => {})));
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function launchHost(): Promise<{ url: string }> {
  if (!root) {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'codeshare-guestverify-'));
    await fs.writeFile(path.join(root, 'a.txt'), 'hello');
  }
  const server = await startServer({ root, sessionCode: CODE, port: 0, host: '127.0.0.1' });
  servers.push(server);
  return { url: server.url };
}

describe('verifyRemote', () => {
  it('returns ok with discovered tools against a healthy host', async () => {
    const { url } = await launchHost();
    const result = await verifyRemote({ url, sessionCode: CODE, timeoutMs: 8000 });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('ok');
    expect(result.serverName).toBe('codeshare');
    expect(result.tools).toContain('codeshare_read_file');
  });

  it('reports auth when the session code is wrong', async () => {
    const { url } = await launchHost();
    const result = await verifyRemote({ url, sessionCode: '999999', timeoutMs: 8000 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('auth');
  });

  it('reports unreachable for a dead endpoint', async () => {
    // Find a port that is not listening.
    const net = await import('node:net');
    const probe = net.createServer();
    await new Promise<void>((res) => probe.listen(0, '127.0.0.1', () => res()));
    const addr = probe.address() as { port: number };
    await new Promise<void>((res) => probe.close(() => res()));
    const result = await verifyRemote({
      url: `http://127.0.0.1:${addr.port}/codeshare`,
      sessionCode: CODE,
      timeoutMs: 3000,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unreachable');
  }, 10000);
});
