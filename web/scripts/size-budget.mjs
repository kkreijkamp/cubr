// The first-load JavaScript budget (to-do "a size budget in CI", 2026-11-26): what a first visit to any
// page downloads before it can run, gzipped (what browsers get), must stay under BUDGET_KB. That is the
// entry script in dist/index.html and every module it preloads; pages loaded on demand don't count.
// Run after `vite build`: node scripts/size-budget.mjs [distDir]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const BUDGET_KB = 200;
const dist = process.argv[2] ?? 'dist';
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const files = [
  ...html.matchAll(/<script[^>]+type="module"[^>]+src="\/([^"]+\.js)"/g),
  ...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="\/([^"]+\.js)"/g),
].map((m) => m[1]);
if (!files.length) {
  console.error('size budget: no module scripts in dist/index.html (did the build change?)');
  process.exit(1);
}
let total = 0;
for (const f of [...new Set(files)]) {
  const kb = gzipSync(readFileSync(join(dist, f)), { level: 9 }).length / 1024;
  total += kb;
  console.log(`  ${kb.toFixed(1).padStart(6)} KB  ${f}`);
}
console.log(`first-load JavaScript: ${total.toFixed(1)} KB gzipped (budget ${BUDGET_KB} KB)`);
if (total > BUDGET_KB) {
  console.error(`over the budget by ${(total - BUDGET_KB).toFixed(1)} KB: load something on demand instead, or raise BUDGET_KB on purpose`);
  process.exit(1);
}
