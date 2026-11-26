import { useEffect, useState } from 'react';
import { useRouteError } from 'react-router-dom';
import { Loading } from './Spinner';
import { isChunkLoadError, reloadForNewRelease } from '../lib/chunkReload';
import { reportCaught } from '../lib/errorReports';

/** Route errorElement: reloads once when a page's chunk is gone after a rollout, else shows (and reports) the error. */
export function RouteError() {
  const error = useRouteError();
  const stale = isChunkLoadError(error);
  const [reloading, setReloading] = useState(stale);
  useEffect(() => {
    if (stale && !reloadForNewRelease()) setReloading(false);
  }, [stale]);
  // a page that broke while rendering: the boundary caught it, so it reaches the error reports only from here
  useEffect(() => {
    if (!stale && error instanceof Error) reportCaught(error);
  }, [error, stale]);

  if (reloading) return <Loading label="loading the new version" />;
  return (
    <div className="empty stack" style={{ justifyItems: 'center', paddingTop: '4rem' }}>
      <div className="sub">{stale ? 'cubr was just updated.' : 'something went wrong.'}</div>
      {!stale && error instanceof Error && <div className="error">{error.message}</div>}
      <button className="btn" onClick={() => location.reload()}>
        reload
      </button>
    </div>
  );
}
