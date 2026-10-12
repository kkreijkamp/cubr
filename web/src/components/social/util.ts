// Small helpers shared by the social pages (login, account).

/** Only allow same-origin relative redirects ("/x", never "//evil.com" or "https://…"). */
export function safeNext(next: string | null | undefined, fallback = '/account'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  if (next.startsWith('/login')) return fallback;
  return next;
}
