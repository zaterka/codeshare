import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { startServer, ENDPOINT_PATH } from '../src/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import selfsigned from 'selfsigned';
import { Agent as UndiciAgent } from 'undici';

const CODE = '654321';

// Generate one self-signed cert for the TLS test group.
const TLS_CERT = selfsigned.generate(
  [{ name: 'commonName', value: 'localhost' }],
  { days: 2, keySize: 2048, algorithm: 'sha256' },
);

// Single dispatcher that ignores cert validation for the TLS loopback tests.
const INSECURE_DISPATCHER = new UndiciAgent({ connect: { rejectUnauthorized: false } });
function buildInsecureFetch(): typeof fetch {
  return (input, init) => fetch(input, { ...init, dispatcher: INSECURE_DISPATCHER } as unknown as RequestInit);
}

describe('codeshare host MCP integration', () => {
  let root: string;
  let server: ReturnType<typeof startServer> extends Promise<infer T> ? T : never;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'codeshare-host-'));
    await fs.writeFile(path.join(root, 'readme.md'), '# Hello\nworld line two\n');
    await fs.mkdir(path.join(root, 'docs'));
    await fs.writeFile(path.join(root, 'docs', 'guide.md'), 'alpha beta\nalpha gamma\n');
    server = await startServer({ root, sessionCode: CODE, port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await server?.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });

  async function relaunch(tls = false) {
    await server?.close().catch(() => {});
    server = await startServer({
      root,
      sessionCode: CODE,
      port: 0,
      host: '127.0.0.1',
      cert: tls ? { cert: TLS_CERT.cert, key: TLS_CERT.private } : undefined,
    });
    return server;
  }

  async function makeClient(opts: { code?: string; insecure?: boolean } = {}) {
    const transport = new StreamableHTTPClientTransport(server.localUrl, {
      requestInit: { headers: { authorization: `Bearer ${opts.code ?? CODE}` } },
      fetch: opts.insecure ? buildInsecureFetch() : undefined,
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(transport);
    return client;
  }

  describe('authentication', () => {
    it('returns 401 with WWW-Authenticate for a bad token', async () => {
      const resp = await fetch(server.localUrl, { headers: { authorization: 'Bearer wrong' } });
      expect(resp.status).toBe(401);
      expect(resp.headers.get('www-authenticate')).toBe('Bearer');
    });

    it('returns 401 when no token is supplied', async () => {
      const resp = await fetch(server.localUrl);
      expect([401, 400, 405]).toContain(resp.status);
    });

    it('returns 404 for a non-endpoint path even with auth', async () => {
      const resp = await fetch(new URL('/other', server.localUrl).href, {
        headers: { authorization: `Bearer ${CODE}` },
      });
      expect(resp.status).toBe(404);
    });

    it('rejects a client that connects with the wrong code', async () => {
      await expect(makeClient({ code: '000000' })).rejects.toThrow();
    });
  });

  describe('tools roundtrip (plain http)', () => {
    let client: InstanceType<typeof Client>;

    beforeAll(async () => {
      client = await makeClient();
    });
    afterAll(async () => {
      await client.close().catch(() => {});
    });

    it('lists all codeshare tools', async () => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      for (const n of [
        'codeshare_read_file',
        'codeshare_write_file',
        'codeshare_edit_file',
        'codeshare_list_files',
        'codeshare_delete_file',
        'codeshare_grep',
      ]) {
        expect(names).toContain(n);
      }
    });

    it('reads a file', async () => {
      const res = await client.callTool({ name: 'codeshare_read_file', arguments: { path: 'readme.md' } });
      expect(res.isError).not.toBe(true);
      expect((res.content[0] as { text: string }).text).toContain('# Hello');
    });

    it('denies reading outside the root', async () => {
      const res = await client.callTool({ name: 'codeshare_read_file', arguments: { path: '../outside' } });
      expect(res.isError).toBe(true);
    });

    it('writes, edits, then deletes a file', async () => {
      const w = await client.callTool({ name: 'codeshare_write_file', arguments: { path: 'notes.txt', content: 'v1' } });
      expect(w.isError).not.toBe(true);

      const e = await client.callTool({
        name: 'codeshare_edit_file',
        arguments: { path: 'notes.txt', find: 'v1', replace: 'v2', occurrence: 1 },
      });
      expect(e.isError).not.toBe(true);

      const r = await client.callTool({ name: 'codeshare_read_file', arguments: { path: 'notes.txt' } });
      expect((r.content[0] as { text: string }).text).toBe('v2');

      const d = await client.callTool({ name: 'codeshare_delete_file', arguments: { path: 'notes.txt' } });
      expect(d.isError).not.toBe(true);
      await expect(fs.stat(path.join(root, 'notes.txt'))).rejects.toThrow();
    });

    it('edit fails atomically when an occurrence is missing', async () => {
      await fs.writeFile(path.join(root, 'edit.txt'), 'only one');
      const e = await client.callTool({
        name: 'codeshare_edit_file',
        arguments: { path: 'edit.txt', find: 'one', replace: 'two', occurrence: 5 },
      });
      expect(e.isError).toBe(true);
      expect(await fs.readFile(path.join(root, 'edit.txt'), 'utf8')).toBe('only one');
    });

    it('grep finds matches', async () => {
      const res = await client.callTool({ name: 'codeshare_grep', arguments: { pattern: 'alpha', dir: '.' } });
      expect(res.isError).not.toBe(true);
      expect((res.content[0] as { text: string }).text).toContain('docs/guide.md');
    });
  });

  describe('two concurrent client sessions', () => {
    it('keeps both sessions independent via the per-session router', async () => {
      await relaunch(false);
      const c1 = await makeClient();
      const c2 = await makeClient();
      const [t1, t2] = await Promise.all([c1.listTools(), c2.listTools()]);
      expect(t1.tools.map((t) => t.name)).toEqual(t2.tools.map((t) => t.name));
      expect(server.connectedSessions.length).toBe(2);

      const w = await c2.callTool({ name: 'codeshare_write_file', arguments: { path: 'shared.txt', content: 'from c2' } });
      expect(w.isError).not.toBe(true);
      const r = await c1.callTool({ name: 'codeshare_read_file', arguments: { path: 'shared.txt' } });
      expect((r.content[0] as { text: string }).text).toBe('from c2');

      await c1.close();
      await c2.close();
    });
  });

  describe('TLS loopback', () => {
    it('serves over TLS and authenticates with a self-signed cert + insecure client', async () => {
      await relaunch(true);
      const client = await makeClient({ insecure: true });
      const { tools } = await client.listTools();
      expect(tools.some((t) => t.name === 'codeshare_read_file')).toBe(true);

      const res = await client.callTool({ name: 'codeshare_read_file', arguments: { path: 'readme.md' } });
      expect((res.content[0] as { text: string }).text).toContain('Hello');

      await client.close();
    });

    it('refuses a wrong code over TLS', async () => {
      await relaunch(true);
      const resp = await buildInsecureFetch()(server.localUrl, {
        headers: { authorization: 'Bearer nope' },
      });
      expect(resp.status).toBe(401);
    });
  });

  describe('endpoint export', () => {
    it('exposes the endpoint path constant', () => {
      expect(ENDPOINT_PATH).toBe('/codeshare');
    });
  });
});
