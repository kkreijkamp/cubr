import type { ReactNode } from 'react';
import { IconCloudOff } from '@tabler/icons-react';
import { friendlyError } from './util';

/** Calm, per-widget failure message with a retry - a down service only degrades its own widget. */
export function WidgetError({ error, what, onRetry, compact }: { error: unknown; what: string; onRetry?: () => void; compact?: boolean }) {
  return (
    <div className={`pv-widget-msg${compact ? ' compact' : ''}`} role="status">
      <IconCloudOff size={16} aria-hidden="true" />
      <span>{friendlyError(error, what)}</span>
      {onRetry && (
        <button className="btn-text" onClick={onRetry}>
          retry
        </button>
      )}
    </div>
  );
}

export function WidgetEmpty({ children, icon, compact }: { children: ReactNode; icon?: ReactNode; compact?: boolean }) {
  return (
    <div className={`pv-widget-msg${compact ? ' compact' : ''}`}>
      {icon}
      <span>{children}</span>
    </div>
  );
}
