import { createRedis, createServer, loadConfig, start } from '@cubetype/common';
import { createInProcessBackend } from './backends.js';
import { ScrambleGenerator } from './generator.js';
import { ScramblePool } from './pool.js';
import { startRefiller, type Refiller } from './refill.js';
import { registerRoutes } from './routes/index.js';
import { newWarmupState, warmUp } from './warmup.js';

const config = loadConfig('scramble');
const warmup = newWarmupState();
/** A scramble may take 15 s from being queued (→ 503); above 250 queued scrambles requests are shed. */
const GENERATOR = { timeoutMs: 15_000, maxQueue: 250 };
/** Every ~2 s top up the emptiest pool with ≤ 5 scrambles, spending ≤ 300 ms of search time per cycle. */
const REFILL = { intervalMs: 2_000, batch: 5, budgetMs: 300 };
let stopping = false;
let refiller: Refiller | null = null;

const server = createServer(config, {
  infoPrefixes: ['/api/scrambles'],
  // Scrambles need nothing but CPU, so readiness only waits for the cubing.js warm-up.
  checks: {
    warmup: async () => {
      if (!warmup.done) throw new Error('warming up');
    },
  },
  // Without Redis the pool is skipped and requests generate directly, so it doesn't gate readiness.
  softChecks: {
    redis: () => redis.ping(),
  },
  info: async () => {
    const mem = process.memoryUsage();
    return {
      warmup,
      generator: generator.stats(),
      pool: { available: scramblePool.available(), ...((await scramblePool.cachedSizes()) ?? { sizes: null }) },
      refill: refiller?.stats() ?? { enabled: true, started: false },
      memory: { rssMB: Math.round(mem.rss / 1048576), heapUsedMB: Math.round(mem.heapUsed / 1048576) },
    };
  },
});
const { app } = server;
const redis = createRedis(config.redisUrl, app.log);

const backend = await createInProcessBackend();
const generator = new ScrambleGenerator(backend, GENERATOR);
const scramblePool = new ScramblePool(redis);
app.log.info({ ...GENERATOR, backend: backend.kind }, 'scramble generator configured');

await registerRoutes(app, { generator, pool: scramblePool });

// Listen first so liveness passes; readiness stays 503 until the warm-up below has finished.
await start(server, config, [
  () => {
    stopping = true;
  },
  () => refiller?.stop(),
  () => generator.close(),
  () => redis.quit(),
]);

await warmUp(generator, warmup, app.log);

if (!stopping) {
  refiller = startRefiller({ pool: scramblePool, generator, log: app.log }, REFILL);
  app.log.info('scramble pool refill loop started');
}
