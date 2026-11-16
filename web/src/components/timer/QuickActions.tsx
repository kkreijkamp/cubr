import { ChatBubbleLeftIcon, TrashIcon } from '@heroicons/react/24/outline';
import type { Penalty } from '@cubr/cubestats';
import { noFocus } from './ConfigBar';
import './quick-actions.css';

interface Props {
  /** the solve the buttons act on; null = none yet (the row keeps its space, hidden) */
  last: { penalty: Penalty; comment?: string | null } | null;
  onPenalty: (p: Penalty) => void;
  /** comment and delete buttons (the timer page); the daily challenge leaves them out */
  onComment?: () => void;
  onDelete?: () => void;
  /** what the buttons act on, for screen readers */
  label?: string;
  className?: string;
}

const OPTIONS: { p: Penalty; label: string; key: string }[] = [
  { p: 'OK', label: 'ok', key: 'ctrl+1' },
  { p: '+2', label: '+2', key: 'ctrl+2' },
  { p: 'DNF', label: 'dnf', key: 'ctrl+3' },
];

/** OK / +2 / DNF (plus comment / delete) for the latest solve (Monkeytype result-button style). */
export function QuickActions({ last, onPenalty, onComment, onDelete, label = 'latest solve', className = '' }: Props) {
  return (
    <div className={`tp-quick${last ? '' : ' hidden'}${className ? ` ${className}` : ''}`} role="group" aria-label={label}>
      {OPTIONS.map((o) => (
        <button
          key={o.p}
          className={`btn-text${last?.penalty === o.p ? ' active' : ''}`}
          onClick={() => onPenalty(o.p)}
          disabled={!last}
          aria-pressed={last?.penalty === o.p}
          data-tip={o.key}
          {...noFocus}
        >
          {o.label}
        </button>
      ))}
      {(onComment || onDelete) && <span className="tp-quick-sep" aria-hidden="true" />}
      {onComment && (
        <button
          className={`btn-text${last?.comment ? ' active' : ''}`}
          onClick={onComment}
          disabled={!last}
          aria-label={`comment on the ${label}`}
          data-tip={last?.comment ? `"${last.comment.slice(0, 40)}${last.comment.length > 40 ? '...' : ''}"` : 'comment (alt+n)'}
          {...noFocus}
        >
          <ChatBubbleLeftIcon width={16} height={16} />
        </button>
      )}
      {onDelete && (
        <button className="btn-text danger" onClick={onDelete} disabled={!last} aria-label={`delete the ${label}`} data-tip="delete (alt+z)" {...noFocus}>
          <TrashIcon width={16} height={16} />
        </button>
      )}
    </div>
  );
}
