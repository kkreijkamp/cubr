// Vite plugin: builds the service worker (src/sw/sw.ts) once the app is built.
// It lists the built files the worker caches (src/sw/policy.ts decides which) and versions the worker
// by their names and contents, so a release that changes nothing in the web app ships a byte-identical
// sw.js: browsers then see no update and nobody gets an "update ready" notice for nothing.
// With VITE_SW=off it builds the kill switch (src/sw/off.ts) instead, which removes the worker and its
// caches from every browser (deploy/vps/README.md).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { build, type Plugin, type ResolvedConfig } from 'vite';
import { precacheUrls } from '../src/sw/policy';

function filesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesIn(join(dir, e.name)) : [join(dir, e.name)]));
}

export function serviceWorker(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'cubr-service-worker',
    apply: 'build',
    configResolved(resolved) {
      config = resolved;
    },
    async closeBundle() {
      const outDir = resolve(config.root, config.build.outDir);
      const off = process.env.VITE_SW === 'off';
      const urls = off ? [] : precacheUrls(filesIn(outDir).map((f) => relative(outDir, f).split(sep).join('/')));
      const hash = createHash('sha256');
      for (const url of urls)
        hash
          .update(url)
          .update('\0')
          .update(readFileSync(join(outDir, url.slice(1))))
          .update('\0');
      const version = hash.digest('hex').slice(0, 16);
      await build({
        configFile: false,
        root: config.root,
        logLevel: 'warn',
        define: { __CUBR_PRECACHE__: JSON.stringify(urls), __CUBR_SW_VERSION__: JSON.stringify(version) },
        build: {
          outDir,
          emptyOutDir: false,
          copyPublicDir: false,
          target: 'es2020',
          lib: { entry: resolve(config.root, off ? 'src/sw/off.ts' : 'src/sw/sw.ts'), formats: ['iife'], name: 'cubrServiceWorker', fileName: () => 'sw.js' },
        },
      });
      config.logger.info(off ? 'service worker: the kill switch (VITE_SW=off)' : `service worker: ${urls.length} files cached, version ${version}`);
    },
  };
}
