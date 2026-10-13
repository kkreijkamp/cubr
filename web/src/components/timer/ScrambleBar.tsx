import { useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, Copy, Pencil, RefreshCw, WifiOff, X } from 'lucide-react';
import type { ScrambleItem } from '../../timer/useScrambleQueue';
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

export function ScrambleBar({ scramble, onNext, onPrev, hasPrev, onCustom, editing, setEditing }: Props) {
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
            <Check size={16} /> use scramble <kbd>enter</kbd>
          </button>
          <button className="btn-text" onClick={() => setEditing(false)}>
            <X size={16} /> cancel <kbd>esc</kbd>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="tp-scramble-wrap fade-on-focus">
      {scramble ? (
        <div className="tp-scramble" style={{ ['--scramble-size' as string]: sizeFor(scramble.text) }} key={scramble.text}>
          {scramble.text}
        </div>
      ) : (
        <div className="tp-scramble tp-scramble-loading">
          generating scramble…
        </div>
      )}
      <div className="tp-scramble-actions">
        {hasPrev && (
          <button className="btn-text" onClick={onPrev} aria-label="previous scramble" data-tip="previous scramble (alt+←)" {...noFocus}>
            <ChevronLeft size={16} />
          </button>
        )}
        <button className="btn-text" onClick={onNext} aria-label="new scramble" data-tip="new scramble (tab)" {...noFocus}>
          <RefreshCw size={16} />
        </button>
        <button className="btn-text" onClick={copy} aria-label="copy scramble" data-tip="copy scramble" disabled={!scramble} {...noFocus}>
          <Copy size={16} />
        </button>
        <button className="btn-text" onClick={() => setEditing(true)} aria-label="enter a custom scramble" data-tip="custom scramble" {...noFocus}>
          <Pencil size={16} />
        </button>
        {scramble?.offline && (
          <span className="tp-scramble-hint" data-tip="the scramble service is unreachable — using random-move scrambles">
            <WifiOff size={12} /> offline scramble
          </span>
        )}
        {scramble?.custom && <span className="tp-scramble-hint">custom scramble</span>}
      </div>
    </div>
  );
}
