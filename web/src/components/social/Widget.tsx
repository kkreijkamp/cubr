import type { ReactNode } from 'react';
import { SignalSlashIcon } from '@heroicons/react/24/outline';
import { friendlyError } from './util';

/** Calm, per-widget failure message with a retry - a down service only degrades its own widget. */
export function WidgetError({ error, what, onRetry, compact }: { error: unknown; what: string; onRetry?: () => void; compact?: boolean }) {
  return (
    <div className={`pv-widget-msg${compact ? ' compact' : ''}`} role="status">
      <SignalSlashIcon width={16} height={16} aria-hidden="true" />
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

/**
 * A profile section: a quiet lowercase label (with optional extras next to it and tools on the
 * right) over its content - no card, sections are set apart by space alone.
 */
export function Section({
  title,
  extra,
  tools,
  label,
  className,
  children,
}: {
  title: ReactNode;
  extra?: ReactNode;
  tools?: ReactNode;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`pf-section${className ? ` ${className}` : ''}`} aria-label={label}>
      <div className="pf-head">
        <h2 className="pf-label">
          {title}
          {extra && <span className="pf-extra">{extra}</span>}
        </h2>
        {tools && <div className="pf-tools">{tools}</div>}
      </div>
      {children}
    </section>
  );
}
