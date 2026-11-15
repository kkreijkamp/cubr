// Bundles one service (or job) into a single ESM file: <dir>/dist/index.mjs
// Usage: node scripts/build-service.mjs services/auth
// Workspace packages (@cubr/*) and all pure-JS npm deps are inlined, so the runtime
// Docker image only needs `node` + this one file. Packages listed in the service's
// package.json "cubr.external" array (e.g. cubing, which spawns worker threads) are
// left as imports and must be copied into the image's node_modules.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/build-service.mjs <service-dir>');
  process.exit(1);
}
const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
const external = ['pg-native', ...(pkg.cubr?.external ?? [])];

await build({
  entryPoints: [path.join(dir, 'src/index.ts')],
  outfile: path.join(dir, 'dist/index.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external,
  legalComments: 'none',
  logLevel: 'info',
  // CommonJS dependencies bundled into ESM still call require()/__dirname
  banner: {
    js: [
      "import { createRequire as __cubrCreateRequire } from 'node:module';",
      "import { fileURLToPath as __cubrFileURLToPath } from 'node:url';",
      "import { dirname as __cubrDirname } from 'node:path';",
      'const require = __cubrCreateRequire(import.meta.url);',
      'const __filename = __cubrFileURLToPath(import.meta.url);',
      'const __dirname = __cubrDirname(__filename);',
    ].join('\n'),
  },
});
