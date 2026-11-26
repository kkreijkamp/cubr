import { averageOfN, effectiveMs, toApiValue } from '@cubr/cubestats';
import type { EarlierTotals, ResultEntry, Results, Standing } from './types.js';

/** Round keys in numeric order ("2" before "10"). */
function roundKeys(results: Results): string[] {
  return Object.keys(results).sort((a, b) => Number(a) - Number(b));
}

/**
 * Standings for the listed players (SPEC section 9.6):
 * - wins: rounds where the player had the best effective time. Ties -> every tied player gets a
 *   win; DNFs never win (a round where everybody DNF'd has no winner).
 * - solves: number of results the player submitted.
 * - meanMs: mean of the player's non-DNF effective times (null if none).
 * - ao5: WCA average of the player's last 5 results (-1 = DNF), null with fewer than 5.
 * Sorted by wins desc, then meanMs asc (null last), then solves desc, then name.
 */
export function computeStandings(players: { id: string; name: string }[], results: Results, earlier: Record<string, EarlierTotals> = {}): Standing[] {
  const wins = new Map<string, number>();
  const times = new Map<string, number[]>(); // chronological effective times per player

  for (const key of roundKeys(results)) {
    const round = results[key];
    let best = Number.POSITIVE_INFINITY;
    for (const [playerId, r] of Object.entries(round)) {
      const t = effectiveMs(r);
      if (!times.has(playerId)) times.set(playerId, []);
      times.get(playerId)!.push(t);
      if (t < best) best = t;
    }
    if (!Number.isFinite(best)) continue; // nobody finished: no winner
    for (const [playerId, r] of Object.entries(round)) {
      if (effectiveMs(r) === best) wins.set(playerId, (wins.get(playerId) ?? 0) + 1);
    }
  }

  const standings = players.map((p): Standing => {
    const e = earlier[p.id];
    const ts = times.get(p.id) ?? [];
    const finite = ts.filter((t) => Number.isFinite(t));
    const count = finite.length + (e?.finite ?? 0);
    const sum = finite.reduce((a, b) => a + b, 0) + (e?.sumMs ?? 0);
    const recent = [...(e?.last ?? []).map(effectiveMs), ...ts];
    return {
      playerId: p.id,
      name: p.name,
      wins: (wins.get(p.id) ?? 0) + (e?.wins ?? 0),
      solves: ts.length + (e?.solves ?? 0),
      meanMs: count ? Math.round(sum / count) : null,
      ao5: recent.length >= 5 ? toApiValue(averageOfN(recent.slice(-5), 5)) : null,
    };
  });

  return standings.sort(
    (a, b) =>
      b.wins - a.wins ||
      (a.meanMs ?? Number.POSITIVE_INFINITY) - (b.meanMs ?? Number.POSITIVE_INFINITY) ||
      b.solves - a.solves ||
      a.name.localeCompare(b.name),
  );
}

/** Adds a round that is being pruned to the players' earlier totals (same rules as computeStandings). */
export function foldRound(earlier: Record<string, EarlierTotals>, round: Record<string, ResultEntry>): void {
  let best = Number.POSITIVE_INFINITY;
  for (const r of Object.values(round)) best = Math.min(best, effectiveMs(r));
  for (const [playerId, r] of Object.entries(round)) {
    const e = (earlier[playerId] ??= { wins: 0, solves: 0, sumMs: 0, finite: 0, last: [] });
    const t = effectiveMs(r);
    e.solves++;
    if (Number.isFinite(t)) {
      e.sumMs += t;
      e.finite++;
    }
    if (Number.isFinite(best) && t === best) e.wins++;
    e.last = [...e.last, r].slice(-5);
  }
}
