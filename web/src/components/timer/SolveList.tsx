import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ChatBubbleLeftEllipsisIcon, ListBulletIcon } from '@heroicons/react/24/outline';
import { formatAverage, type Precision } from '@cubr/cubestats';
import type { Solve } from '../../lib/types';
import { fmtSolveShort } from './statsUtil';
import { Loading } from '../Spinner';

const ROW = 30;
/** a fingertip's height on a touch screen, as the other touch targets (global.css) */
const TOUCH_ROW = 44;
const OVERSCAN = 8;

function touchScreen(): boolean {
  try {
    return matchMedia('(hover: none) and (pointer: coarse)').matches;
  } catch {
    return false;
  }
}

interface Props {
  solves: Solve[];
  ao5: (number | null)[];
  ao12: (number | null)[];
  /** per solve: did its single / ao5 / ao12 set a new session best when it happened */
  pbs: { single: boolean[]; ao5: boolean[]; ao12: boolean[] };
  bestIndex: number | null;
  precision: Precision;
  loading: boolean;
  onOpen: (index: number) => void;
}

/**
 * Newest-first solve list. Only the rows in view are rendered (fixed row height), so sessions
 * with tens of thousands of solves scroll smoothly.
 */
export const SolveList = memo(function SolveList({ solves, ao5, ao12, pbs, bestIndex, precision, loading, onOpen }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(360);
  const row = useMemo(() => (touchScreen() ? TOUCH_ROW : ROW), []);
  const n = solves.length;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight || 360));
    ro.observe(el);
    return () => ro.disconnect();
  }, [n > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // new solve -> jump back to the top (the newest row)
  const prevN = useRef(n);
  useEffect(() => {
    if (n > prevN.current && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
      setScrollTop(0);
    }
    prevN.current = n;
  }, [n]);

  const first = Math.max(0, Math.floor(scrollTop / row) - OVERSCAN);
  const last = Math.min(n, Math.ceil((scrollTop + viewH) / row) + OVERSCAN);
  const rows = [];
  for (let r = first; r < last; r++) {
    const i = n - 1 - r;
    const s = solves[i];
    rows.push(
      <div
        key={s.id}
        className={`tp-solve-row${r % 2 === 0 ? ' odd' : ''}${i === bestIndex ? ' best' : ''}`}
        style={{ transform: `translateY(${r * row}px)`, height: row }}
        onClick={() => onOpen(i)}
        role="button"
        tabIndex={-1}
        aria-label={`solve ${i + 1}: ${fmtSolveShort(s, precision)}`}
      >
        <span className="idx">{i + 1}</span>
        <span className={`time${s.penalty === 'DNF' ? ' dnf' : ''}${pbs.single[i] ? ' pb' : ''}`}>
          {fmtSolveShort(s, precision)}
          {s.comment && <ChatBubbleLeftEllipsisIcon width={11} height={11} className="tp-comment-mark" aria-label="has comment" aria-hidden={false} />}
        </span>
        <span className={pbs.ao5[i] ? 'pb' : undefined}>{formatAverage(ao5[i], precision)}</span>
        <span className={pbs.ao12[i] ? 'pb' : undefined}>{formatAverage(ao12[i], precision)}</span>
      </div>,
    );
  }

  return (
    <section className="tp-panel tp-solves" aria-label="solves">
      <div className="tp-panel-title">
        <ListBulletIcon width={14} height={14} /> solves
      </div>
      {loading && n === 0 ? (
        <Loading />
      ) : n === 0 ? (
        <div className="tp-empty">
          no solves in this session yet
          <span>your times will appear here</span>
        </div>
      ) : (
        <>
          <div className="tp-solve-head">
            <span className="idx">#</span>
            <span className="time">time</span>
            <span>ao5</span>
            <span>ao12</span>
          </div>
          <div className="tp-solve-scroll" ref={scrollRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
            <div className="tp-solve-inner" style={{ height: n * row }}>
              {rows}
            </div>
          </div>
        </>
      )}
    </section>
  );
});
