import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { generateSessionCode, type ServerOptions } from '@codeshare/shared';
import { startServer } from './server.js';

interface Args {
  root?: string;
  port?: number;
  'session-code'?: string;
  cert?: string;
  key?: string;
  host?: string;
  help?: boolean;
}

function usage(): string {
  return `
codeshare-host — serve a folder as an authenticated MCP server for a remote AI.

Usage:
  codeshare-host serve --root <folder> [options]

Options:
  --root <folder>      Folder to expose (required)
  --port <n>           Port to listen on (default 8443)
  --session-code <c>   Session code; if omitted a random 6-digit code is generated and printed
  --cert <file>        PEM TLS certificate (recommended for internet use; pair with --key)
  --key <file>         PEM TLS private key
  --host <addr>        Bind host (default 0.0.0.0)
  --help               Show this help

Notes:
  * Without --cert/--key the server runs plain HTTP (fine for LAN/dev; NOT safe over the open internet).
  * For internet use, terminate TLS at your own reverse proxy with a real cert and set --cert/--key, or
    point clients at the proxy URL with the same session code.
`.trim();
}

export async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      root: { type: 'string' },
      port: { type: 'string' },
      'session-code': { type: 'string' },
      cert: { type: 'string' },
      key: { type: 'string' },
      host: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const a = values as unknown as Args;

  if (a.help) {
    console.log(usage());
    return;
  }
  if (!a.root) {
    console.error(usage());
    process.exit(2);
  }

  const port = a.port ? Number(a.port) : 8443;
  const sessionCode = a['session-code'] ?? generateSessionCode();
  const options: ServerOptions = {
    root: a.root,
    port,
    sessionCode,
    host: a.host ?? '0.0.0.0',
  };
  if (a.cert || a.key) {
    if (!a.cert || !a.key) {
      console.error('Both --cert and --key are required together.');
      process.exit(2);
    }
    options.cert = {
      cert: await fs.readFile(a.cert, 'utf8'),
      key: await fs.readFile(a.key, 'utf8'),
    };
  }

  const server = await startServer(options);
  console.log(`codeshare serving ${a.root}`);
  console.log(`URL:  ${server.url}`);
  console.log(`Code: ${sessionCode}`);
  console.log('Include it as: Authorization: Bearer <code>');
  console.log('Share the URL + code with your guest. Press Ctrl+C to stop.');

  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      await server.close();
      resolve();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
