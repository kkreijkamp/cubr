import { describe, expect, it } from 'vitest';
import postcss, { type Container } from 'postcss';
import { hoverMedia, usesHover } from '../../plugins/hoverMedia';

const run = (css: string) => postcss([hoverMedia()]).process(css, { from: undefined }).css;
/** the CSS with its spacing evened out (the build minifies it anyway) */
const squash = (css: string) =>
  css
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}])\s*/g, ' $1 ')
    .replace(/\s+/g, ' ')
    .trim();

describe('hover styles only where something can hover', () => {
  it('wraps a hover rule in @media (hover: hover)', () => {
    expect(squash(run('.a:hover { color: red; }'))).toBe('@media (hover: hover) { .a:hover { color: red; } }');
  });

  it('keeps the selectors that need no hover where they are, for touch screens too', () => {
    expect(squash(run('.a:hover, .a.active { color: red; }'))).toBe(
      '.a.active { color: red; } @media (hover: hover) { .a:hover { color: red; } }',
    );
    expect(squash(run('.b, .c { color: blue; }'))).toBe('.b, .c { color: blue; }');
  });

  it('handles pseudo-elements, :has and descendants of a hovered element', () => {
    expect(squash(run('[data-tip]:hover::after { opacity: 1; }'))).toBe('@media (hover: hover) { [data-tip]:hover::after { opacity: 1; } }');
    expect(squash(run('.row:hover > span, .row:has(a:hover) { color: red; }'))).toBe(
      '@media (hover: hover) { .row:hover > span, .row:has(a:hover) { color: red; } }',
    );
  });

  it('leaves :not(:hover), which holds on a touch screen as it is', () => {
    expect(usesHover('.a:not(:hover)')).toBe(false);
    expect(usesHover('.a:not(.b):hover')).toBe(true);
    expect(usesHover('.a:not(:is(.b, .c:hover)) .d')).toBe(false);
    expect(squash(run('.a:not(:hover) { color: red; }'))).toBe('.a:not(:hover) { color: red; }');
  });

  it('leaves rules already in a hover media query, and nests inside other media queries', () => {
    expect(squash(run('@media (hover: hover) { .a:hover { color: red; } }'))).toBe('@media (hover: hover) { .a:hover { color: red; } }');
    expect(squash(run('@media (max-width: 720px) { .a:hover { color: red; } }'))).toBe(
      '@media (max-width: 720px) { @media (hover: hover) { .a:hover { color: red; } } }',
    );
  });

  // every stylesheet of the app, as the build sees it
  const sheets = import.meta.glob<string>('../**/*.css', { query: '?raw', import: 'default', eager: true });
  it('leaves no hover style outside a hover media query in any stylesheet', () => {
    expect(Object.keys(sheets).length).toBeGreaterThan(10);
    let hoverRules = 0;
    for (const [file, css] of Object.entries(sheets)) {
      postcss([hoverMedia()])
        .process(css, { from: file })
        .root.walkRules((rule) => {
          if (!rule.selectors.some(usesHover)) return;
          hoverRules++;
          let gated = false;
          for (let p: Container | undefined = rule.parent; p && p.type !== 'root'; p = p.parent as Container | undefined) {
            if (p.type === 'atrule' && 'params' in p && String(p.params).includes('(hover: hover)')) gated = true;
          }
          expect(gated, `${file}: ${rule.selector}`).toBe(true);
        });
    }
    expect(hoverRules).toBeGreaterThan(50);
  });
});
