import { useEffect } from 'react';
import { HOME } from './pageMeta';

/**
 * The page's title (the tab, and search results) and description while it shows; the home page's again
 * on leaving, as in index.html. Search engines read both after running the app. A page without a
 * description of its own (a personal or one-off page) keeps the home page's. Public pages take theirs
 * from lib/pageMeta.ts, which the build also writes into their HTML.
 */
export function usePageMeta({ title, description = HOME.description }: { title: string; description?: string }): void {
  useEffect(() => {
    const meta = document.querySelector('meta[name="description"]');
    document.title = title;
    meta?.setAttribute('content', description);
    return () => {
      document.title = HOME.title;
      meta?.setAttribute('content', HOME.description);
    };
  }, [title, description]);
}
