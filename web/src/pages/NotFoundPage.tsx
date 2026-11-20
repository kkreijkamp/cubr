import { Link } from 'react-router-dom';
import { useNoIndex } from '../lib/useNoIndex';
import { usePageMeta } from '../lib/usePageMeta';

/**
 * Any URL the app doesn't know. The server already answers these with a 404 (web/nginx), so crawlers
 * see the status; the noindex covers the app shell the service worker serves offline.
 */
export default function NotFoundPage() {
  useNoIndex();
  usePageMeta({ title: 'page not found | cubr' });
  return (
    <div className="empty stack" style={{ justifyItems: 'center', paddingTop: '4rem' }}>
      <h1 style={{ fontSize: '4rem' }} className="main">
        404
      </h1>
      <div className="sub">this page got scrambled.</div>
      <Link to="/" className="btn">
        back to the timer
      </Link>
    </div>
  );
}
