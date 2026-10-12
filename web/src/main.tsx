import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/roboto-mono/400.css';
import '@fontsource/roboto-mono/700.css';
import '@fontsource/lexend-deca/400.css';
import './styles/global.css';
import { App } from './App';
import { applyVisualSettings } from './lib/settings';

applyVisualSettings();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
