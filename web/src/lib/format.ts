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

/** 12345 → "12,345" */
export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-';
  return n.toLocaleString('en-US');
}
