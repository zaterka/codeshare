import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

const shared = [
  { entryPoints: ['src/index.ts'], outfile: 'dist/index.js', format: 'esm' },
  { entryPoints: ['src/cli.ts'], outfile: 'dist/cli.js', format: 'esm', banner: { js: '#!/usr/bin/env node' } },
];

mkdirSync(path.join(dir, 'dist'), { recursive: true });

for (const opts of shared) {
  await build({
    bundle: true,
    platform: 'node',
    target: 'node20',
    sourcemap: true,
    external: [],
    ...opts,
  });
}

// Copy shared's compiled output next to host so relative imports in the bundle resolve via node_modules.
// esbuild bundles @codeshare/shared in, so nothing extra is needed at runtime.
console.log('host build complete');
