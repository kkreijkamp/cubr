import { ChatIcon, TrashIcon } from '@phosphor-icons/react';
import type { Penalty } from '@cubetype/cubestats';
import type { Solve } from '../../lib/types';
import { noFocus } from './ConfigBar';

interface Props {
  last: Solve | null;
  onPenalty: (p: Penalty) => void;
  onComment: () => void;
  onDelete: () => void;
}

const OPTIONS: { p: Penalty; label: string; key: string }[] = [
  { p: 'OK', label: 'ok', key: 'alt+1' },
  { p: '+2', label: '+2', key: 'alt+2' },
  { p: 'DNF', label: 'dnf', key: 'alt+3' },
];

/** OK / +2 / DNF / comment / delete for the latest solve (Monkeytype result-button style). */
export function QuickActions({ last, onPenalty, onComment, onDelete }: Props) {
  return (
    <div className={`tp-quick${last ? '' : ' hidden'}`} role="group" aria-label="latest solve">
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
      <span className="tp-quick-sep" aria-hidden="true" />
      <button
        className={`btn-text${last?.comment ? ' active' : ''}`}
        onClick={onComment}
        disabled={!last}
        aria-label="comment on the latest solve"
        data-tip={last?.comment ? `"${last.comment.slice(0, 40)}${last.comment.length > 40 ? '...' : ''}"` : 'comment (alt+c)'}
        {...noFocus}
      >
        <ChatIcon size={16} />
      </button>
      <button className="btn-text danger" onClick={onDelete} disabled={!last} aria-label="delete the latest solve" data-tip="delete (alt+backspace)" {...noFocus}>
        <TrashIcon size={16} />
      </button>
    </div>
  );
}
