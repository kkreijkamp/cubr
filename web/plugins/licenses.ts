// dist/licenses.txt: the open-source licences of everything the web app ships to browsers, written at
// build time from what actually ended up in the bundle (each package's own package.json and licence
// file), plus the fonts. About links to it; nginx serves it like any other file of the site.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

export interface PackageLicense {
  name: string;
  version: string;
  /** the SPDX expression in its package.json */
  license: string;
  /** its licence file, as it is; empty if it has none */
  text: string;
}

/** The fonts the app's CSS loads (@fontsource): CSS, so they're not in the JavaScript bundle's module list. */
export const FONT_PACKAGES = ['@fontsource/comfortaa', '@fontsource/lexend-deca', '@fontsource/roboto-mono'];

/** The folder of the npm package a bundled module came from (".../node_modules/@scope/name"), null for the app's own code. */
export function packageRoot(moduleId: string): string | null {
  const path = moduleId.replace(/^\0/, '').split('?')[0].replace(/\\/g, '/');
  const at = path.lastIndexOf('/node_modules/');
  if (at < 0) return null;
  const rest = path.slice(at + '/node_modules/'.length).split('/');
  const segments = rest[0]?.startsWith('@') ? 2 : 1;
  if (rest.length <= segments) return null;
  return `${path.slice(0, at)}/node_modules/${rest.slice(0, segments).join('/')}`;
}

/** A package's name, version, licence and licence text, read from its folder. */
export function readPackage(root: string): PackageLicense | null {
  const manifest = join(root, 'package.json');
  if (!existsSync(manifest)) return null;
  const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; version?: string; license?: unknown };
  const file = readdirSync(root).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f));
  return {
    name: pkg.name ?? root.split('/').pop()!,
    version: pkg.version ?? '',
    license: typeof pkg.license === 'string' ? pkg.license : 'see its licence text',
    text: file ? readFileSync(join(root, file), 'utf8').trim() : '',
  };
}

const RULE = '='.repeat(78);

/** The file: cubr's own licence and where its source is, then each package with its licence text, by name. */
export function renderLicenses(packages: PackageLicense[], repoUrl: string): string {
  const sorted = [...packages].sort((a, b) => a.name.localeCompare(b.name));
  const lines = [
    'cubr: open-source licences',
    '',
    `cubr is free software under the GNU General Public License, version 3 (GPL-3.0-only). Its source code is at ${repoUrl}.`,
    '',
    `The web app includes these ${sorted.length} packages, each under its own licence (the full texts follow):`,
    '',
    ...sorted.map((p) => `  ${p.name} ${p.version}: ${p.license}`),
  ];
  for (const p of sorted) {
    lines.push('', RULE, `${p.name} ${p.version} (${p.license})`, RULE, '', p.text || `No licence file in the package; its package.json says: ${p.license}.`);
  }
  return `${lines.join('\n')}\n`;
}

export function licensesFile(repoUrl: string): Plugin {
  return {
    name: 'cubr-licenses',
    apply: 'build',
    generateBundle(_options, bundle) {
      const roots = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        for (const id of Object.keys(output.modules)) {
          const root = packageRoot(id);
          if (root) roots.add(root);
        }
      }
      for (const font of FONT_PACKAGES) roots.add(join(process.cwd(), 'node_modules', font));
      const packages = [...roots].map(readPackage).filter((p): p is PackageLicense => p !== null);
      // a package bundled from two places (two copies) is listed once per version
      const unique = [...new Map(packages.map((p) => [`${p.name}@${p.version}`, p])).values()];
      this.emitFile({ type: 'asset', fileName: 'licenses.txt', source: renderLicenses(unique, repoUrl) });
    },
  };
}
