/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// The SPA talks to the backend through same-origin paths (/api/*). In dev, Vite proxies them to
// the local gateway (docker compose, port 8080) which mimics the K8s Ingress.
const gateway = process.env.CUBETYPE_GATEWAY ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@cubetype/cubestats': fileURLToPath(new URL('../packages/cubestats/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: gateway, changeOrigin: true },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});
