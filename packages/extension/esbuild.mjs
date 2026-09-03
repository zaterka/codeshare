import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
mkdirSync(path.join(dir, 'out'), { recursive: true });

await build({
  entryPoints: ['src/extension.ts'],
  outfile: 'out/extension.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  // `vscode` is provided by the extension host at runtime; Node builtins stay external.
  external: ['vscode', 'node:*'],
});

console.log('extension build complete');
