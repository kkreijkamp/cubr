import { createPool, createRedis, createServer, loadConfig, migrate, start } from '@cubetype/common';
import { createInProcessBackend } from './backends.js';
import { DailyChallenges } from './daily.js';
import { ScrambleGenerator } from './generator.js';
import { migrations } from './migrations.js';
import { ScramblePool } from './pool.js';
import { startRefiller, type Refiller } from './refill.js';
import { registerRoutes } from './routes/index.js';
import { errorMessage, sleep } from './util.js';
import { newWarmupState, warmUp } from './warmup.js';

const config = loadConfig('scramble');
const warmup = newWarmupState();
/** A scramble may take 15 s from being queued (→ 503); above 250 queued scrambles requests are shed. */
const GENERATOR = { timeoutMs: 15_000, maxQueue: 250 };
/** Every ~2 s top up the emptiest pool with ≤ 5 scrambles, spending ≤ 300 ms of search time per cycle. */
const REFILL = { intervalMs: 2_000, batch: 5, budgetMs: 300 };
let migrated = false;
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
  // Redis (pool → falls back to direct generation) and Postgres (daily challenge only → 503 on
  // /daily) both degrade gracefully, so neither gates readiness.
  softChecks: {
    redis: () => redis.ping(),
    postgres: () => pg.query('select 1'),
  },
  info: async () => {
    const mem = process.memoryUsage();
    return {
      warmup,
      generator: generator.stats(),
      pool: { available: scramblePool.available(), ...((await scramblePool.cachedSizes()) ?? { sizes: null }) },
      refill: refiller?.stats() ?? { enabled: true, started: false },
      daily: { migrated },
      memory: { rssMB: Math.round(mem.rss / 1048576), heapUsedMB: Math.round(mem.heapUsed / 1048576) },
    };
  },
});
const { app } = server;
const pg = createPool(config.databaseUrl, { max: 5, log: app.log });
const redis = createRedis(config.redisUrl, app.log);

const backend = await createInProcessBackend();
const generator = new ScrambleGenerator(backend, GENERATOR);
const scramblePool = new ScramblePool(redis);
const daily = new DailyChallenges({ pool: pg, generator, isMigrated: () => migrated, log: app.log });
app.log.info({ ...GENERATOR, backend: backend.kind }, 'scramble generator configured');

await registerRoutes(app, { generator, pool: scramblePool, daily });

// Listen first so liveness passes; readiness stays 503 until the warm-up below has finished.
await start(server, config, [
  () => {
    stopping = true;
  },
  () => refiller?.stop(),
  () => generator.close(),
  () => pg.end(),
  () => redis.quit(),
]);

// The daily-challenge table is the only thing that needs Postgres: migrate in the background,
// retrying forever, instead of blocking startup on the database.
void (async () => {
  let delay = 1000;
  while (!stopping) {
    try {
      await migrate(pg, 'scramble', migrations, app.log);
      migrated = true;
      app.log.info('scramble schema migrated');
      return;
    } catch (err) {
      app.log.warn({ err: errorMessage(err) }, `scramble migrations failed, retrying in ${delay}ms (daily challenge unavailable)`);
      await sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }
  }
})();

await warmUp(generator, warmup, app.log);

if (!stopping) {
  refiller = startRefiller({ pool: scramblePool, generator, log: app.log }, REFILL);
  app.log.info('scramble pool refill loop started');
}
