/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { serviceWorker } from './plugins/serviceWorker';
import { hoverMedia } from './plugins/hoverMedia';

// The SPA talks to the backend through same-origin paths (/api/*, /socket.io). In dev, Vite
// proxies them to the local gateway (docker compose, port 8080) which mimics the K8s Ingress.
const gateway = process.env.CUBR_GATEWAY ?? 'http://localhost:8080';

export default defineConfig({
  // serviceWorker: dist/sw.js, the offline app (src/sw/), built after the app
  plugins: [react(), serviceWorker()],
  // hover styles only where something can hover: a tap left them on (plugins/hoverMedia.ts)
  css: { postcss: { plugins: [hoverMedia()] } },
  resolve: {
    alias: {
      '@cubr/cubestats': fileURLToPath(new URL('../packages/cubestats/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: gateway, changeOrigin: true },
      '/socket.io': { target: gateway, ws: true, changeOrigin: true },
      '/_info': { target: gateway, changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  worker: { format: 'es' },
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    // CSS is left out of tests (an empty module) unless listed here; lib/__tests__/themes.test.ts reads
    // the stylesheet's first-paint colours as text (global.css?raw), and __tests__/hoverMedia.test.ts
    // every stylesheet (?raw)
    css: { include: [/\/src\/styles\/global\.css/, /\.css\?raw$/] },
  },
});
