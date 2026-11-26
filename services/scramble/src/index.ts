import { createPool, createRedis, createServer, loadConfig, migrate, pingPostgres, start } from '@cubr/common';
import { createBackend } from './backends.js';
import { createCsTimerHost } from './cstimer.js';
import { DailyChallenges } from './daily.js';
import { ScrambleGenerator } from './generator.js';
import { migrations } from './migrations.js';
import { ScramblePool } from './pool.js';
import { startRefiller, type Refiller } from './refill.js';
import { registerRoutes } from './routes/index.js';
import { loadScrambleSettings } from './settings.js';
import { errorMessage, sleep } from './util.js';
import { newWarmupState, warmUp } from './warmup.js';

const config = loadConfig('scramble');
const settings = loadScrambleSettings();
const warmup = newWarmupState();
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
  // Redis (pool -> falls back to direct generation) and Postgres (daily challenge only -> 503 on
  // /daily) both degrade gracefully, so neither gates readiness.
  softChecks: {
    redis: () => redis.ping(),
    postgres: () => pingPostgres(pg),
  },
  info: async () => {
    const mem = process.memoryUsage();
    return {
      warmup,
      generator: generator.stats(),
      cstimer: cstimer.stats(),
      pool: { available: scramblePool.available(), ...((await scramblePool.cachedSizes()) ?? { sizes: null }) },
      refill: refiller?.stats() ?? { enabled: settings.refillEnabled, started: false },
      daily: { migrated },
      memory: { rssMB: Math.round(mem.rss / 1048576), heapUsedMB: Math.round(mem.heapUsed / 1048576) },
    };
  },
});
const { app } = server;
const pg = createPool(config.databaseUrl, { max: 5, log: app.log });
const redis = createRedis(config.redisUrl, app.log);

const backend = await createBackend(settings.workers, app.log);
const generator = new ScrambleGenerator(backend, { timeoutMs: settings.timeoutMs, maxQueue: settings.maxQueue });
// csTimer's own scramblers, in a worker thread of their own (started on the first request)
const cstimer = createCsTimerHost({ timeoutMs: settings.timeoutMs, maxQueue: settings.maxQueue });
const scramblePool = new ScramblePool(redis);
const daily = new DailyChallenges({ pool: pg, generator, isMigrated: () => migrated, log: app.log });
app.log.info({ ...settings, backend: backend.kind }, 'scramble generator configured');

await registerRoutes(app, { generator, pool: scramblePool, daily, redis, internalToken: config.internalToken, cstimer });

// Listen first so liveness passes; readiness stays 503 until the warm-up below has finished.
await start(server, config, [
  () => {
    stopping = true;
  },
  () => refiller?.stop(),
  () => generator.close(),
  () => cstimer.close(),
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

if (settings.refillEnabled && !stopping) {
  refiller = startRefiller(
    { pool: scramblePool, generator, log: app.log },
    { intervalMs: settings.refillIntervalMs, batch: settings.refillBatch, budgetMs: settings.refillBudgetMs },
  );
  app.log.info('scramble pool refill loop started');
}
