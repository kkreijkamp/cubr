// Themes: Monkeytype's palettes (exact values from monkeytype's frontend/src/ts/constants/themes.ts,
// normalised to #rrggbb).
export interface Theme {
  name: string;
  bg: string;
  main: string;
  caret: string;
  sub: string;
  subAlt: string;
  text: string;
  error: string;
  errorExtra: string;
  colorfulError: string;
  colorfulErrorExtra: string;
}

export const THEMES: Theme[] = [
  {"name":"8008","bg":"#333a45","main":"#f44c7f","caret":"#f44c7f","sub":"#939eae","subAlt":"#2e343d","text":"#e9ecf0","error":"#da3333","errorExtra":"#791717","colorfulError":"#c5da33","colorfulErrorExtra":"#849224"},
  {"name":"botanical","bg":"#7b9c98","main":"#eaf1f3","caret":"#abc6c4","sub":"#495755","subAlt":"#72908d","text":"#eaf1f3","error":"#f6c9b4","errorExtra":"#f59a71","colorfulError":"#f6c9b4","colorfulErrorExtra":"#f59a71"},
  {"name":"carbon","bg":"#313131","main":"#f66e0d","caret":"#f66e0d","sub":"#616161","subAlt":"#2b2b2b","text":"#f5e6c8","error":"#e72d2d","errorExtra":"#7e2a33","colorfulError":"#e72d2d","colorfulErrorExtra":"#7e2a33"},
  {"name":"dracula","bg":"#282a36","main":"#bd93f9","caret":"#bd93f9","sub":"#6272a4","subAlt":"#20222c","text":"#f8f8f2","error":"#ff5555","errorExtra":"#f1fa8c","colorfulError":"#ff5555","colorfulErrorExtra":"#f1fa8c"},
  {"name":"nord","bg":"#242933","main":"#88c0d0","caret":"#eceff4","sub":"#929aaa","subAlt":"#2e3440","text":"#d8dee9","error":"#bf616a","errorExtra":"#793e44","colorfulError":"#bf616a","colorfulErrorExtra":"#793e44"},
  {"name":"serika","bg":"#e1e1e3","main":"#e2b714","caret":"#e2b714","sub":"#aaaeb3","subAlt":"#d1d3d8","text":"#323437","error":"#da3333","errorExtra":"#791717","colorfulError":"#da3333","colorfulErrorExtra":"#791717"},
  {"name":"serika_dark","bg":"#323437","main":"#e2b714","caret":"#e2b714","sub":"#646669","subAlt":"#2c2e31","text":"#d1d0c5","error":"#ca4754","errorExtra":"#7e2a33","colorfulError":"#ca4754","colorfulErrorExtra":"#7e2a33"},
  {"name":"solarized_dark","bg":"#002b36","main":"#859900","caret":"#dc322f","sub":"#2aa198","subAlt":"#00222b","text":"#268bd2","error":"#d33682","errorExtra":"#9b225c","colorfulError":"#d33682","colorfulErrorExtra":"#9b225c"},
  {"name":"solarized_light","bg":"#fdf6e3","main":"#859900","caret":"#dc322f","sub":"#2aa198","subAlt":"#e2d8be","text":"#181819","error":"#d33682","errorExtra":"#9b225c","colorfulError":"#d33682","colorfulErrorExtra":"#9b225c"},
];

export const DEFAULT_THEME = 'serika_dark';

const BY_NAME = new Map(THEMES.map((t) => [t.name, t]));

export function getTheme(name: string): Theme {
  return BY_NAME.get(name) ?? BY_NAME.get(DEFAULT_THEME)!;
}

/** "serika_dark" → "serika dark" */
export function themeLabel(name: string): string {
  return name.replace(/_/g, ' ');
}

const VARS: [Exclude<keyof Theme, 'name'>, string][] = [
  ['bg', '--bg-color'],
  ['main', '--main-color'],
  ['caret', '--caret-color'],
  ['sub', '--sub-color'],
  ['subAlt', '--sub-alt-color'],
  ['text', '--text-color'],
  ['error', '--error-color'],
  ['errorExtra', '--error-extra-color'],
  ['colorfulError', '--colorful-error-color'],
  ['colorfulErrorExtra', '--colorful-error-extra-color'],
];

/** Applies a theme's colours to :root. `persist` stores them for the pre-paint script in index.html. */
export function applyTheme(name: string, persist = true): void {
  const theme = getTheme(name);
  const root = document.documentElement;
  const colors: Record<string, string> = {};
  for (const [k, v] of VARS) {
    root.style.setProperty(v, theme[k]);
    colors[v] = theme[k];
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.bg);
  if (persist) {
    try {
      localStorage.setItem('cubetype.themeColors', JSON.stringify(colors));
    } catch {
      /* ignore */
    }
  }
}
