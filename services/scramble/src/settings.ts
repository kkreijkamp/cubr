/** Scramble-service specific environment variables (the shared ones come from loadConfig). */
export interface ScrambleSettings {
  /** Parallel scramble searches per pod. 1 = cubing.js' own single search worker (default);
   *  >1 = a worker_threads pool, each thread running its own cubing.js instance (~100 MB each). */
  workers: number;
  /** Max time a scramble may take, measured from when it was queued -> 503 afterwards. */
  timeoutMs: number;
  /** Max queued scrambles before requests are shed with 503 (protects latency under overload). */
  maxQueue: number;
  /** Background pool refill: how often each replica checks the Redis pool. */
  refillIntervalMs: number;
  /** Background pool refill: max scrambles generated per check. */
  refillBatch: number;
  /** Background pool refill: max generation time per check (bounds refill CPU to ~budget/interval). */
  refillBudgetMs: number;
  refillEnabled: boolean;
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  const n = raw === undefined || raw === '' ? fallback : Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function loadScrambleSettings(env: NodeJS.ProcessEnv = process.env): ScrambleSettings {
  const refill = (env.SCRAMBLE_REFILL ?? '1').toLowerCase();
  return {
    workers: int(env, 'SCRAMBLE_WORKERS', 1, 1, 16),
    timeoutMs: int(env, 'SCRAMBLE_TIMEOUT_MS', 15_000, 1_000, 120_000),
    maxQueue: int(env, 'SCRAMBLE_MAX_QUEUE', 250, 1, 10_000),
    refillIntervalMs: int(env, 'SCRAMBLE_REFILL_INTERVAL_MS', 2_000, 100, 60_000),
    refillBatch: int(env, 'SCRAMBLE_REFILL_BATCH', 5, 1, 50),
    refillBudgetMs: int(env, 'SCRAMBLE_REFILL_BUDGET_MS', 300, 10, 60_000),
    refillEnabled: !['0', 'false', 'off', 'no'].includes(refill),
  };
}
