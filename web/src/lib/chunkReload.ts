// After a web rollout, a tab that is still open references the previous release's chunk names,
// which the new pods answer with 404 (web/nginx: `try_files $uri =404`). Reloading fetches the
// new index.html and its chunks. While old and new pods both serve, a fresh index.html can still
// miss its chunks on an old pod, so reload at most once per 10 s instead of looping.
const KEY = 'cubetype:chunk-reload-at';
const WINDOW_MS = 10_000;

let reloading = false;

/** True for the errors browsers and Vite raise when a code-split chunk can't be loaded. */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  // Chrome / Firefox / Safari / Vite's CSS preload
  return /dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(message);
}

/**
 * Reloads the page to pick up the current release. Returns false when it already reloaded in the
 * last 10 s (or can't remember whether it did), so the caller shows an error instead.
 */
export function reloadForNewRelease(): boolean {
  if (reloading) return true;
  try {
    if (Date.now() - Number(sessionStorage.getItem(KEY)) < WINDOW_MS) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    return false; // no storage: a reload could loop
  }
  reloading = true;
  location.reload();
  return true;
}
