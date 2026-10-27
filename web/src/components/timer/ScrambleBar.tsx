import { Fragment, useEffect, useRef, useState } from 'react';
import { ArrowPathIcon, CheckIcon, ChevronLeftIcon, PencilIcon, SignalSlashIcon, Square2StackIcon, XMarkIcon } from '@heroicons/react/24/outline';
import type { ScrambleItem } from '../../timer/useScrambleQueue';
import type { ScrambleHint } from '../../input/bluetooth/smartSession';
import { toast } from '../../lib/toast';
import { copyText } from './feedback';
import { noFocus } from './ConfigBar';

interface Props {
  scramble: ScrambleItem | null;
  onNext: () => void;
  onPrev: () => void;
  hasPrev: boolean;
  onCustom: (text: string) => void;
  editing: boolean;
  setEditing: (v: boolean) => void;
  /** a smart cube's progress along the scramble */
  hint?: ScrambleHint | null;
}

/** Font size steps by scramble length: 2x2/3x3 large, big cubes & megaminx smaller. */
function sizeFor(text: string): string {
  const n = text.length;
  if (n <= 50) return '1.75rem';
  if (n <= 90) return '1.5rem';
  if (n <= 160) return '1.25rem';
  if (n <= 320) return '1.05rem';
  if (n <= 600) return '0.95rem';
  return '0.85rem';
}

export function ScrambleBar({ scramble, onNext, onPrev, hasPrev, onCustom, editing, setEditing, hint }: Props) {
  const [draft, setDraft] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(scramble?.text ?? '');
      requestAnimationFrame(() => taRef.current?.select());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const copy = async () => {
    if (!scramble) return;
    const ok = await copyText(scramble.text);
    if (ok) toast.success('scramble copied', { durationMs: 1500 });
    else toast.error("couldn't access the clipboard");
  };

  const save = () => {
    if (draft.trim()) onCustom(draft);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="tp-scramble-wrap">
        <textarea
          ref={taRef}
          className="tp-scramble-edit"
          value={draft}
          rows={3}
          maxLength={2000}
          spellCheck={false}
          aria-label="custom scramble"
          placeholder="paste or type a scramble"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              save();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setEditing(false);
            }
          }}
        />
        <div className="tp-scramble-actions">
          <button className="btn-text" onClick={save}>
            <CheckIcon width={16} height={16} /> use scramble <kbd>enter</kbd>
          </button>
          <button className="btn-text" onClick={() => setEditing(false)}>
            <XMarkIcon width={16} height={16} /> cancel <kbd>esc</kbd>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="tp-scramble-wrap fade-on-focus">
      {scramble ? (
        <div className={`tp-scramble${hint?.pending ? ' off' : ''}`} style={{ ['--scramble-size' as string]: sizeFor(scramble.text) }} key={scramble.text}>
          {hint && !hint.pending ? <HintedMoves hint={hint} /> : scramble.text}
        </div>
      ) : (
        <div className="tp-scramble tp-scramble-loading">
          generating scramble...
        </div>
      )}
      <div className="tp-scramble-actions">
        {hasPrev && (
          <button className="btn-text" onClick={onPrev} aria-label="previous scramble" data-tip="previous scramble (alt+<-)" {...noFocus}>
            <ChevronLeftIcon width={16} height={16} />
          </button>
        )}
        <button className="btn-text" onClick={onNext} aria-label="new scramble" data-tip="new scramble (tab)" {...noFocus}>
          <ArrowPathIcon width={16} height={16} />
        </button>
        <button className="btn-text" onClick={copy} aria-label="copy scramble" data-tip="copy scramble" disabled={!scramble} {...noFocus}>
          <Square2StackIcon width={16} height={16} />
        </button>
        <button className="btn-text" onClick={() => setEditing(true)} aria-label="enter a custom scramble" data-tip="custom scramble (alt+i)" {...noFocus}>
          <PencilIcon width={16} height={16} />
        </button>
        {scramble?.offline && (
          <span className="tp-scramble-hint" data-tip="the scramble service is unreachable - using random-move scrambles">
            <SignalSlashIcon width={12} height={12} /> offline scramble
          </span>
        )}
        {scramble?.custom && <span className="tp-scramble-hint">custom scramble</span>}
        {scramble?.fromCube && (
          <span className="tp-scramble-hint" data-tip="the cube was scrambled by hand: this is a scramble that gives the same state">
            read from the cube
          </span>
        )}
        {hint && (hint.fix || hint.pending) && <span className="tp-scramble-hint">{hint.pending ? 'off the scramble' : 'off the scramble - these turns lead back'}</span>}
      </div>
    </div>
  );
}

/** csTimer's smart cube scramble: turns done dimmed, the current one marked (what's left of it, if half done), a tick when it's all done */
function HintedMoves({ hint }: { hint: ScrambleHint }) {
  const complete = hint.done >= hint.moves.length;
  return (
    <>
      {hint.moves.map((m, i) => (
        <Fragment key={i}>
          {i > 0 && ' '}
          <span className={complete ? undefined : i < hint.done ? 'sm-done' : i === hint.done ? 'sm-current' : undefined}>{i === hint.done && hint.rest ? hint.rest : m}</span>
        </Fragment>
      ))}
      {complete && (
        <span className="sm-check" aria-label="scrambled">
          {' '}
          <CheckIcon width="0.8em" height="0.8em" />
        </span>
      )}
    </>
  );
}
