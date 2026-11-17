import { ArrowPathIcon } from '@heroicons/react/24/outline';
import { useEffect, useState } from 'react';

export function Spinner({ size = 20 }: { size?: number }) {
  return <ArrowPathIcon className="spinner" width={size} height={size} />;
}

/** Centered spinner that only appears after a short delay (no flash on fast loads). */
export function Loading({ label }: { label?: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShow(true), 150);
    return () => clearTimeout(t);
  }, []);
  if (!show) return null;
  return (
    <div className="empty row" style={{ justifyContent: 'center' }}>
      <Spinner /> {label && <span>{label}</span>}
    </div>
  );
}

/**
 * A long page's loading state: it holds a screen's height, so the footer starts below the screen
 * instead of sitting at its bottom and being pushed off when the page arrives (a layout shift on
 * phones). For pages that end up taller than the screen; a short page would pull the footer back up.
 * The spinner appears after the same short delay as Loading's.
 */
export function PageLoading() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShow(true), 150);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="page-tall" aria-busy="true">
      {show && (
        <div className="empty row" style={{ justifyContent: 'center' }}>
          <Spinner />
        </div>
      )}
    </div>
  );
}

/** Friendly error card with a retry button. */
export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="empty stack" style={{ justifyItems: 'center' }}>
      <div className="error">{error.message || 'Something went wrong'}</div>
      {onRetry && (
        <button className="btn small" onClick={onRetry}>
          try again
        </button>
      )}
    </div>
  );
}
