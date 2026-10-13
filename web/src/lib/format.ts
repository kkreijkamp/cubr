export { formatTime, formatSolve, formatDuration, getEvent, EVENTS } from '@cubetype/cubestats';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "14 Oct 2026" */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "14 Oct 2026 21:05" */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return `${formatDate(iso)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "3 minutes ago" style relative time */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '-';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (Number.isNaN(s)) return '-';
  if (s < 45) return 'just now';
  const units: [number, string][] = [
    [60, 'minute'],
    [3600, 'hour'],
    [86400, 'day'],
    [604800, 'week'],
    [2629800, 'month'],
    [31557600, 'year'],
  ];
  let label = '1 minute';
  for (let i = units.length - 1; i >= 0; i--) {
    const [secs, name] = units[i];
    if (s >= secs) {
      const n = Math.round(s / secs);
      label = `${n} ${name}${n === 1 ? '' : 's'}`;
      break;
    }
  }
  return `${label} ago`;
}

/** Local calendar date "YYYY-MM-DD". */
export function localDateKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** UTC calendar date "YYYY-MM-DD" (daily leaderboards are UTC-based). */
export function utcDateKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** ISO-3166 alpha-2 → flag emoji. */
export function flagEmoji(iso2: string | null | undefined): string {
  if (!iso2 || !/^[A-Za-z]{2}$/.test(iso2)) return '';
  const base = 0x1f1e6;
  const up = iso2.toUpperCase();
  return String.fromCodePoint(base + up.charCodeAt(0) - 65, base + up.charCodeAt(1) - 65);
}

/** 12345 → "12,345" */
export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-';
  return n.toLocaleString('en-US');
}

/** Percent with sensible precision: 99.95 → "99.95%", 12.3456 → "12.3%" */
export function formatPercent(p: number): string {
  if (p >= 99 || p < 1) return `${p.toFixed(2)}%`;
  return `${p.toFixed(1)}%`;
}
