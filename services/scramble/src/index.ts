import { createServer, loadConfig, start } from '@cubetype/common';
import { createInProcessBackend } from './backends.js';
import { ScrambleGenerator } from './generator.js';
import { registerRoutes } from './routes/index.js';
import { newWarmupState, warmUp } from './warmup.js';

const config = loadConfig('scramble');
const warmup = newWarmupState();
/** A scramble may take 15 s from being queued (→ 503); above 250 queued scrambles requests are shed. */
const GENERATOR = { timeoutMs: 15_000, maxQueue: 250 };

const server = createServer(config, {
  infoPrefixes: ['/api/scrambles'],
  // Scrambles need nothing but CPU, so readiness only waits for the cubing.js warm-up.
  checks: {
    warmup: async () => {
      if (!warmup.done) throw new Error('warming up');
    },
  },
  info: () => {
    const mem = process.memoryUsage();
    return {
      warmup,
      generator: generator.stats(),
      memory: { rssMB: Math.round(mem.rss / 1048576), heapUsedMB: Math.round(mem.heapUsed / 1048576) },
    };
  },
});
const { app } = server;

const backend = await createInProcessBackend();
const generator = new ScrambleGenerator(backend, GENERATOR);
app.log.info({ ...GENERATOR, backend: backend.kind }, 'scramble generator configured');

await registerRoutes(app, { generator });

// Listen first so liveness passes; readiness stays 503 until the warm-up below has finished.
await start(server, config, [() => generator.close()]);

await warmUp(generator, warmup, app.log);
