import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/comfortaa/400.css';
import '@fontsource/comfortaa/700.css';
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
