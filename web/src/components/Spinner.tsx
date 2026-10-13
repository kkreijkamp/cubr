import { LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';

export function Spinner({ size = 20 }: { size?: number }) {
  return <LoaderCircle className="spinner" size={size} />;
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
