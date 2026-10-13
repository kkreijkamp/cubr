import type { Redis } from '@cubetype/common';
import { EVENT_IDS } from '@cubetype/cubestats';
import { withTimeout } from './util.js';

/** Target length of `scramble:pool:<event>` (SPEC §9.2): popular + cheap events get deeper pools. */
export const POOL_TARGETS: Readonly<Record<string, number>> = {
  '333': 200, '222': 200, pyram: 200, skewb: 200,
  '444': 50, sq1: 50, clock: 50, minx: 50, '333oh': 50, '333bf': 50, '333fm': 50,
  '555': 20, '666': 20, '777': 20, '444bf': 20, '555bf': 20,
};

export const poolKey = (event: string) => `scramble:pool:${event}`;

export interface RefillPick {
  event: string;
  /** scrambles missing until the target is reached */
  deficit: number;
}

/**
 * Chooses which pool to top up next: the one that is relatively emptiest (deficit / target), ties
 * broken by the larger absolute deficit, then by EVENTS order (333 first). Missing sizes count as 0.
 * Returns null when every pool is at its target.
 */
export function pickRefillEvent(
  sizes: Readonly<Record<string, number | undefined>>,
  targets: Readonly<Record<string, number>> = POOL_TARGETS,
  order: readonly string[] = EVENT_IDS,
): RefillPick | null {
  let best: RefillPick | null = null;
  let bestRatio = 0;
  for (const event of order) {
    const target = targets[event];
    if (!target) continue;
    const deficit = target - Math.max(0, sizes[event] ?? 0);
    if (deficit <= 0) continue;
    const ratio = deficit / target;
    if (!best || ratio > bestRatio || (ratio === bestRatio && deficit > best.deficit)) {
      best = { event, deficit };
      bestRatio = ratio;
    }
  }
  return best;
}

export interface PoolOptions {
  /** per-command timeout: a paused/partitioned Redis must not stall requests */
  timeoutMs?: number;
  /** after a failure, skip Redis entirely for this long (simple circuit breaker) */
  cooldownMs?: number;
}

/**
 * Redis-backed scramble pool shared by all replicas. Every method fails fast when Redis is
 * unhealthy so callers can fall back to generating scrambles directly.
 */
export class ScramblePool {
  private downUntil = 0;
  private lastSizes: { at: number; sizes: Record<string, number> } | null = null;
  private readonly timeoutMs: number;
  private readonly cooldownMs: number;

  constructor(
    private readonly redis: Redis,
    opts: PoolOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 250;
    this.cooldownMs = opts.cooldownMs ?? 3000;
  }

  /** False while the connection is down or the circuit breaker is open. */
  available(): boolean {
    return this.redis.status === 'ready' && Date.now() >= this.downUntil;
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.available()) throw new Error('redis unavailable');
    try {
      return await withTimeout(fn(), this.timeoutMs, () => new Error('redis command timed out'));
    } catch (err) {
      this.downUntil = Date.now() + this.cooldownMs;
      throw err;
    }
  }

  /** Pops up to `count` scrambles (Redis ≥ 6.2 `LPOP key count`). */
  async take(event: string, count: number): Promise<string[]> {
    const popped = await this.call(() => this.redis.lpop(poolKey(event), count));
    return popped ?? [];
  }

  /** Appends scrambles and trims the list to its target (other replicas may have raced us). */
  async push(event: string, scrambles: string[]): Promise<number> {
    const key = poolKey(event);
    const cap = POOL_TARGETS[event] ?? 20;
    const res = await this.call(() =>
      this.redis.multi().rpush(key, ...scrambles).ltrim(key, 0, cap - 1).llen(key).exec(),
    );
    return Number(res?.[2]?.[1] ?? 0);
  }

  /** LLEN of every pool in one round trip. */
  async sizes(): Promise<Record<string, number>> {
    const res = await this.call(() => {
      const pipe = this.redis.pipeline();
      for (const event of EVENT_IDS) pipe.llen(poolKey(event));
      return pipe.exec();
    });
    const sizes: Record<string, number> = {};
    EVENT_IDS.forEach((event, i) => {
      const [err, n] = res?.[i] ?? [];
      sizes[event] = err ? 0 : Number(n ?? 0);
    });
    this.lastSizes = { at: Date.now(), sizes };
    return sizes;
  }

  /** Pool sizes for _info: cached for `maxAgeMs`, stale (or null) while Redis is down. */
  async cachedSizes(maxAgeMs = 3000): Promise<{ sizes: Record<string, number>; ageMs: number } | null> {
    if (!this.lastSizes || Date.now() - this.lastSizes.at > maxAgeMs) {
      await this.sizes().catch(() => {});
    }
    return this.lastSizes ? { sizes: this.lastSizes.sizes, ageMs: Date.now() - this.lastSizes.at } : null;
  }
}
