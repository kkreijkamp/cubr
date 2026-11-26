import { memo, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ChatBubbleLeftEllipsisIcon, ListBulletIcon } from '@heroicons/react/24/outline';
import { formatAverage, type Precision } from '@cubr/cubestats';
import type { Solve } from '../../lib/types';
import { fmtSolveShort } from './statsUtil';
import { Loading } from '../Spinner';
import { solvingStore } from '../../timer/useTimerEngine';

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
 * with tens of thousands of solves scroll smoothly. From the keyboard it is a listbox: Tab reaches
 * it, the arrow keys, Page Up / Down, Home and End move along the solves and Enter opens one; Space
 * stays the timer's.
 */
export const SolveList = memo(function SolveList({ solves, ao5, ao12, pbs, bestIndex, precision, loading, onOpen }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(360);
  const row = useMemo(() => (touchScreen() ? TOUCH_ROW : ROW), []);
  const n = solves.length;
  const listId = useId();
  /** the solve the keyboard is on (null = the newest), and whether the keyboard has the list */
  const [cursor, setCursor] = useState<number | null>(null);
  const [keyboard, setKeyboard] = useState(false);
  const at = cursor !== null && cursor < n ? cursor : n - 1;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight || 360));
    ro.observe(el);
    return () => ro.disconnect();
  }, [n > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // new solve -> jump back to the top (the newest row), the keyboard's place too
  const prevN = useRef(n);
  useEffect(() => {
    if (n > prevN.current && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
      setScrollTop(0);
      setCursor(null);
    }
    prevN.current = n;
  }, [n]);

  /** puts the keyboard on solve `i` and scrolls its row into view, rendered in the same pass */
  const moveTo = (i: number) => {
    const to = Math.max(0, Math.min(n - 1, i));
    setCursor(to);
    setKeyboard(true);
    const el = scrollRef.current;
    if (!el) return;
    const top = (n - 1 - to) * row;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + row > el.scrollTop + el.clientHeight) el.scrollTop = top + row - el.clientHeight;
    setScrollTop(el.scrollTop);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // a solve under way owns every key (any key stops it); modified keys are shortcuts
    if (solvingStore.get() || e.altKey || e.ctrlKey || e.metaKey || n === 0) return;
    const page = Math.max(1, Math.floor(viewH / row) - 1);
    const to: Record<string, number> = { ArrowDown: at - 1, ArrowUp: at + 1, PageDown: at - page, PageUp: at + page, Home: n - 1, End: 0 };
    if (e.key === 'Enter') {
      e.preventDefault();
      onOpen(at);
    } else if (e.key in to) {
      e.preventDefault(); // the list is newest first: down is older; this also keeps the page's arrow shortcuts out
      moveTo(to[e.key]);
    }
  };

  const first = Math.max(0, Math.floor(scrollTop / row) - OVERSCAN);
  const last = Math.min(n, Math.ceil((scrollTop + viewH) / row) + OVERSCAN);
  const rows = [];
  for (let r = first; r < last; r++) {
    const i = n - 1 - r;
    const s = solves[i];
    const here = keyboard && i === at;
    rows.push(
      // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/interactive-supports-focus -- focus stays on the listbox, which names this row (aria-activedescendant); its keys are the listbox's
      <div
        key={s.id}
        id={`${listId}-${i}`}
        className={`tp-solve-row${r % 2 === 0 ? ' odd' : ''}${i === bestIndex ? ' best' : ''}${here ? ' cursor' : ''}`}
        style={{ transform: `translateY(${r * row}px)`, height: row }}
        onClick={() => {
          setCursor(i); // the keyboard carries on from the solve clicked
          onOpen(i);
        }}
        role="option"
        aria-selected={here}
        aria-posinset={r + 1}
        aria-setsize={n}
        aria-label={`solve ${i + 1}: ${fmtSolveShort(s, precision)}${s.comment ? ', has a comment' : ''}`}
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
          <div
            className="tp-solve-scroll"
            ref={scrollRef}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
            role="listbox"
            tabIndex={0}
            aria-label="solves, newest first: arrow keys to move, enter to open"
            aria-activedescendant={keyboard ? `${listId}-${at}` : undefined}
            onKeyDown={onKeyDown}
            // the keyboard's place shows when it arrives by keyboard, not with a click
            onFocus={(e) => setKeyboard(e.currentTarget.matches(':focus-visible'))}
            onBlur={() => setKeyboard(false)}
          >
            <div className="tp-solve-inner" style={{ height: n * row }}>
              {rows}
            </div>
          </div>
        </>
      )}
    </section>
  );
});
