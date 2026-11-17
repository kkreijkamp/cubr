// Hover styles only where something can hover: wraps every :hover selector in @media (hover: hover).
//
// On a touch screen a tap leaves the tapped element :hover until the next tap somewhere else, so
// hover colours stayed on buttons, rows and links after they were tapped. Selectors in a list that
// don't use :hover stay where they are: `.a:hover, .a.active { ... }` keeps `.a.active` for touch
// screens too. A `:not(:hover)` holds on a touch screen as it is, so it's left alone. Touch screens
// get their feedback from :active instead (global.css), while the finger is down.
//
// Runs on every stylesheet Vite builds (vite.config.ts css.postcss); src/__tests__/hoverMedia.test.ts.
import type { AtRule as AtRuleNode, Container, Plugin } from 'postcss';

export const HOVER_QUERY = '(hover: hover)';
const HOVER_MEDIA = /\(\s*(any-)?hover\s*:\s*hover\s*\)/;

/** whether a selector depends on :hover (outside any :not(...), which also holds without hover) */
export function usesHover(selector: string): boolean {
  let out = '';
  for (let i = 0; i < selector.length; i++) {
    if (selector.startsWith(':not(', i)) {
      let depth = 0;
      for (i += 4; i < selector.length; i++) {
        if (selector[i] === '(') depth++;
        else if (selector[i] === ')' && --depth === 0) break;
      }
      continue;
    }
    out += selector[i];
  }
  return out.includes(':hover');
}

function insideHoverMedia(node: Container | undefined): boolean {
  for (let p = node; p && p.type !== 'root'; p = p.parent as Container | undefined) {
    if (p.type === 'atrule' && (p as AtRuleNode).name === 'media' && HOVER_MEDIA.test((p as AtRuleNode).params)) return true;
  }
  return false;
}

export function hoverMedia(): Plugin {
  return {
    postcssPlugin: 'cubr-hover-media',
    Rule(rule, { AtRule }) {
      if (!rule.selector.includes(':hover') || insideHoverMedia(rule.parent)) return;
      const hover = rule.selectors.filter(usesHover);
      if (!hover.length) return;
      const rest = rule.selectors.filter((s) => !usesHover(s));
      const media = new AtRule({ name: 'media', params: HOVER_QUERY });
      media.append(rule.clone({ selectors: hover }));
      rule.after(media);
      if (rest.length) rule.selectors = rest;
      else rule.remove();
    },
  };
}
hoverMedia.postcss = true as const;
