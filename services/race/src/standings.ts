import { averageOfN, effectiveMs, toApiValue } from '@cubetype/cubestats';
import type { Results, Standing } from './types.js';

/** Round keys in numeric order ("2" before "10"). */
function roundKeys(results: Results): string[] {
  return Object.keys(results).sort((a, b) => Number(a) - Number(b));
}

/**
 * Standings for the listed players (SPEC §9.6):
 * - wins: rounds where the player had the best effective time. Ties → every tied player gets a
 *   win; DNFs never win (a round where everybody DNF'd has no winner).
 * - solves: number of results the player submitted.
 * - meanMs: mean of the player's non-DNF effective times (null if none).
 * - ao5: WCA average of the player's last 5 results (-1 = DNF), null with fewer than 5.
 * Sorted by wins desc, then meanMs asc (null last), then solves desc, then name.
 */
export function computeStandings(players: { id: string; name: string }[], results: Results): Standing[] {
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
    const ts = times.get(p.id) ?? [];
    const finite = ts.filter((t) => Number.isFinite(t));
    return {
      playerId: p.id,
      name: p.name,
      wins: wins.get(p.id) ?? 0,
      solves: ts.length,
      meanMs: finite.length ? Math.round(finite.reduce((a, b) => a + b, 0) / finite.length) : null,
      ao5: ts.length >= 5 ? toApiValue(averageOfN(ts.slice(-5), 5)) : null,
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
