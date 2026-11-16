import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'services/*/test/**/*.test.ts', 'jobs/*/test/**/*.test.ts'],
    environment: 'node',
    // integration suites (real Postgres/Redis, bcrypt) run in parallel; a CI runner is slower than a laptop
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
