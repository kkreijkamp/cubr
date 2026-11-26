import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { FONT_PACKAGES, packageRoot, readPackage, renderLicenses } from '../licenses';

// dist/licenses.txt (plugins/licenses.ts): the licences of what the web app ships, from the bundle itself.
// Here, not under src: it needs Node's own modules, and the image build type-checks src without Node's types.
const NODE_MODULES = fileURLToPath(new URL('../../node_modules', import.meta.url));

describe('licenses.txt', () => {
  it("finds the package a bundled module came from, and none for the app's own code", () => {
    expect(packageRoot('/w/node_modules/react/cjs/react.production.min.js')).toBe('/w/node_modules/react');
    expect(packageRoot('/w/node_modules/@kurkle/color/dist/color.esm.js')).toBe('/w/node_modules/@kurkle/color');
    expect(packageRoot('/w/node_modules/a/node_modules/b/index.js?commonjs-proxy')).toBe('/w/node_modules/a/node_modules/b');
    expect(packageRoot('\0/w/node_modules/react/index.js?commonjs-module')).toBe('/w/node_modules/react');
    expect(packageRoot('C:\\w\\node_modules\\react\\index.js')).toBe('C:/w/node_modules/react');
    expect(packageRoot('/w/src/main.tsx')).toBeNull();
    expect(packageRoot('/w/node_modules/react')).toBeNull();
  });

  it("reads a package's name, version, licence and licence text, fonts included", () => {
    const react = readPackage(`${NODE_MODULES}/react`)!;
    expect(react).toMatchObject({ name: 'react', license: 'MIT' });
    expect(react.text).toMatch(/MIT License/);
    for (const font of FONT_PACKAGES) {
      const p = readPackage(`${NODE_MODULES}/${font}`)!;
      expect(p.name, font).toBe(font);
      expect(p.license, font).toMatch(/OFL|Apache/);
      expect(p.text, font).toMatch(/SIL OPEN FONT LICENSE|Apache License/i);
    }
    expect(readPackage(`${NODE_MODULES}/no-such-package`)).toBeNull();
  });

  it("starts with cubr's own licence and its source, lists every package by name, then their texts", () => {
    const text = renderLicenses(
      [
        { name: 'zz', version: '1.0.0', license: 'MIT', text: 'zz text' },
        { name: 'aa', version: '2.0.0', license: 'MPL-2.0', text: '' },
      ],
      'https://github.com/kkreijkamp/cubr',
    );
    expect(text).toMatch(/^cubr: open-source licences\n/);
    expect(text).toContain('GNU General Public License, version 3 (GPL-3.0-only). Its source code is at https://github.com/kkreijkamp/cubr.');
    expect(text.indexOf('  aa 2.0.0: MPL-2.0')).toBeLessThan(text.indexOf('  zz 1.0.0: MIT'));
    expect(text).toContain('zz text');
    expect(text).toContain('No licence file in the package; its package.json says: MPL-2.0.');
  });
});
