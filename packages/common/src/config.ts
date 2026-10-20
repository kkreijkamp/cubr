import os from 'node:os';

export interface ServiceUrls {
  auth: string;
  scramble: string;
  solve: string;
  stats: string;
  leaderboard: string;
  wca: string;
  race: string;
}

export interface BaseConfig {
  port: number;
  serviceName: string;
  version: string;
  podName: string;
  nodeName: string;
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  /** Shared secret for /internal/* routes (X-Internal-Token); empty = not enforced (local development). */
  internalToken: string;
  logLevel: string;
  urls: ServiceUrls;
}

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

/** Reads the environment variables shared by every service (see docs/SPEC.md section 4). */
export function loadConfig(serviceName: string): BaseConfig {
  return {
    port: Number(env('PORT', '8080')),
    serviceName: env('SERVICE_NAME', serviceName),
    version: env('APP_VERSION', 'dev'),
    podName: env('POD_NAME', os.hostname()),
    nodeName: env('NODE_NAME', 'local'),
    databaseUrl: env('DATABASE_URL', 'postgres://cubetype:cubetype@postgres:5432/cubetype'),
    redisUrl: env('REDIS_URL', 'redis://redis:6379'),
    jwtSecret: env('JWT_SECRET', 'dev-secret-change-me'),
    internalToken: env('INTERNAL_API_TOKEN', ''),
    logLevel: env('LOG_LEVEL', 'info'),
    urls: {
      auth: env('AUTH_URL', 'http://auth:8080'),
      scramble: env('SCRAMBLE_URL', 'http://scramble:8080'),
      solve: env('SOLVE_URL', 'http://solve:8080'),
      stats: env('STATS_URL', 'http://stats:8080'),
      leaderboard: env('LEADERBOARD_URL', 'http://leaderboard:8080'),
      wca: env('WCA_URL', 'http://wca:8080'),
      race: env('RACE_URL', 'http://race:8080'),
    },
  };
}
