// Bundles one service (or job) into a single ESM file: <dir>/dist/index.mjs
// Usage: node scripts/build-service.mjs services/auth
// Workspace packages (@cubetype/*) and all pure-JS npm deps are inlined, so the runtime
// Docker image only needs `node` + this one file.
import { build } from 'esbuild';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/build-service.mjs <service-dir>');
  process.exit(1);
}
const external = ['pg-native'];

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
      "import { createRequire as __cubetypeCreateRequire } from 'node:module';",
      "import { fileURLToPath as __cubetypeFileURLToPath } from 'node:url';",
      "import { dirname as __cubetypeDirname } from 'node:path';",
      'const require = __cubetypeCreateRequire(import.meta.url);',
      'const __filename = __cubetypeFileURLToPath(import.meta.url);',
      'const __dirname = __cubetypeDirname(__filename);',
    ].join('\n'),
  },
});
