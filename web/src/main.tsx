import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { IconContext } from '@phosphor-icons/react';
import '@fontsource/roboto-mono/400.css';
import '@fontsource/roboto-mono/700.css';
import '@fontsource/lexend-deca/400.css';
import './styles/global.css';
import { App } from './App';
import { reloadForNewRelease } from './lib/chunkReload';
import { applyVisualSettings } from './lib/settings';

applyVisualSettings();

// A dynamic import outside the router (e.g. cubing.js) failed: its chunk belongs to the previous release.
window.addEventListener('vite:preloadError', () => reloadForNewRelease());

// Icons without a size prop render at 24px (Phosphor's own default is 1em).
const ICON_DEFAULTS = { size: 24 };

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <IconContext.Provider value={ICON_DEFAULTS}>
      <App />
    </IconContext.Provider>
  </StrictMode>,
);
