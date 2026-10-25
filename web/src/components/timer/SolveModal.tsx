import { useEffect, useRef, useState } from 'react';
import { ChevronLeftIcon, ChevronRightIcon, Square2StackIcon, TrashIcon } from '@heroicons/react/24/outline';
import { getEvent, type Penalty, type Precision } from '@cubetype/cubestats';
import { Modal } from '../Modal';
import { TwistyPreview } from '../TwistyPreview';
import type { Solve } from '../../lib/types';
import type { PreviewMode } from '../../lib/settings';
import { deleteSolve, setComment, setPenalty } from '../../lib/solves';
import { formatDateTime, timeAgo } from '../../lib/format';
import { toast } from '../../lib/toast';
import { copyText } from './feedback';
import { fmtSolveLong } from './statsUtil';

interface Props {
  solve: Solve;
  index: number;
  total: number;
  precision: Precision;
  preview: PreviewMode;
  confirmDelete: boolean;
  onNavigate: (index: number) => void;
  onClose: () => void;
}

const PENALTIES: Penalty[] = ['OK', '+2', 'DNF'];

export function SolveModal({ solve, index, total, precision, preview, confirmDelete, onNavigate, onClose }: Props) {
  const [comment, setCommentText] = useState(solve.comment ?? '');
  const [armed, setArmed] = useState(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setCommentText(solve.comment ?? '');
    setArmed(false);
  }, [solve.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => {
    if (armTimer.current) clearTimeout(armTimer.current);
  }, []);

  const saveComment = () => {
    if ((solve.comment ?? '') !== comment.trim()) void setComment(solve.id, comment);
  };

  // <-/-> browse solves (not while typing a comment)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && ['INPUT', 'TEXTAREA'].includes(t.tagName)) return;
      if (e.key === 'ArrowLeft' && index > 0) onNavigate(index - 1);
      else if (e.key === 'ArrowRight' && index < total - 1) onNavigate(index + 1);
      else if (e.ctrlKey && !e.altKey && !e.metaKey && /^Digit[123]$/.test(e.code)) {
        e.preventDefault();
        void setPenalty(solve.id, PENALTIES[Number(e.code.slice(5)) - 1]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, total, onNavigate, solve.id]);

  const remove = () => {
    if (confirmDelete && !armed) {
      setArmed(true);
      if (armTimer.current) clearTimeout(armTimer.current);
      armTimer.current = setTimeout(() => setArmed(false), 3000);
      return;
    }
    void deleteSolve(solve.id);
    toast.notice('solve deleted', { durationMs: 1500 });
    onClose();
  };

  const puzzle = getEvent(solve.event)?.puzzle ?? '3x3x3';
  const dnf = solve.penalty === 'DNF';

  return (
    <Modal
      title={
        <span className="tp-modal-title">
          solve <span className="text">#{index + 1}</span>
          <span className="tp-modal-nav">
            <button className="btn-text" onClick={() => onNavigate(index - 1)} disabled={index === 0} aria-label="previous solve" data-tip="previous (<-)">
              <ChevronLeftIcon width={18} height={18} />
            </button>
            <button className="btn-text" onClick={() => onNavigate(index + 1)} disabled={index >= total - 1} aria-label="next solve" data-tip="next (->)">
              <ChevronRightIcon width={18} height={18} />
            </button>
          </span>
        </span>
      }
      onClose={() => {
        saveComment();
        onClose();
      }}
    >
      <div className="tp-solve-detail">
        <div className={`tp-solve-time${dnf ? ' dnf' : ''}`}>{fmtSolveLong(solve, precision)}</div>
        <div className="tp-solve-meta" title={formatDateTime(solve.createdAt)}>
          {formatDateTime(solve.createdAt)} - {timeAgo(solve.createdAt)}
          {solve.source !== 'timer' && <span className="pill">{solve.source}</span>}
        </div>
      </div>

      <div className="option-group" role="group" aria-label="penalty">
        {PENALTIES.map((p, i) => (
          <button key={p} className={`btn${solve.penalty === p ? ' active' : ''}`} onClick={() => void setPenalty(solve.id, p)} data-tip={`ctrl+${i + 1}`}>
            {p === 'OK' ? 'no penalty' : p.toLowerCase()}
          </button>
        ))}
      </div>

      <div className="tp-detail-block">
        <div className="row between">
          <span className="label">scramble</span>
          <button
            className="btn-text small"
            onClick={async () => {
              if (await copyText(solve.scramble)) toast.success('scramble copied', { durationMs: 1500 });
            }}
            disabled={!solve.scramble}
          >
            <Square2StackIcon width={14} height={14} /> copy
          </button>
        </div>
        <div className="tp-detail-scramble">{solve.scramble || <span className="sub">no scramble recorded</span>}</div>
        {preview !== 'off' && solve.scramble && (
          <div className="tp-detail-preview">
            <TwistyPreview puzzle={puzzle} scramble={solve.scramble} visualization={preview} height={150} />
          </div>
        )}
      </div>

      <div className="field">
        <label htmlFor="solve-comment">comment</label>
        <textarea
          id="solve-comment"
          rows={2}
          maxLength={500}
          value={comment}
          placeholder="add a note - e.g. pll skip, lockup on f2l"
          onChange={(e) => setCommentText(e.target.value)}
          onBlur={saveComment}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              saveComment();
              (e.target as HTMLTextAreaElement).blur();
            }
          }}
        />
      </div>

      <div className="dialog-actions tp-detail-actions">
        <button className={`btn ${armed ? 'danger' : ''}`} onClick={remove}>
          <TrashIcon width={16} height={16} /> {armed ? 'click again to delete' : 'delete solve'}
        </button>
        <button
          className="btn primary"
          onClick={() => {
            saveComment();
            onClose();
          }}
        >
          done
        </button>
      </div>
    </Modal>
  );
}
