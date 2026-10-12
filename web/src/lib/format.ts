/** 12345 → "12,345" */
export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-';
  return n.toLocaleString('en-US');
}
