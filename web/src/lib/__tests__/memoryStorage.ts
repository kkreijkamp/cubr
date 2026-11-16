/**
 * In-memory Storage (localStorage / sessionStorage) for tests. Set `full = true` to make setItem
 * throw like a browser whose storage quota is used up.
 */
export class MemoryStorage {
  private readonly map = new Map<string, string>();
  full = false;

  constructor(entries: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(entries)) this.map.set(k, v);
  }

  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    if (this.full) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
  /** The parsed JSON stored under `k` (null when there is none). */
  json<T = unknown>(k: string): T | null {
    const v = this.map.get(k);
    return v === undefined ? null : (JSON.parse(v) as T);
  }
}
