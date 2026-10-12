import { memo } from 'react';
import { List } from 'lucide-react';
import type { Precision } from '@cubetype/cubestats';
import type { Solve } from '../../lib/types';
import { fmtAvg, fmtSolveShort } from './statsUtil';

interface Props {
  solves: Solve[];
  ao5: (number | null)[];
  ao12: (number | null)[];
  bestIndex: number | null;
  precision: Precision;
}

/** Newest-first solve list with the rolling ao5 / ao12 after each solve. */
export const SolveList = memo(function SolveList({ solves, ao5, ao12, bestIndex, precision }: Props) {
  const n = solves.length;
  const rows = [];
  for (let r = 0; r < n; r++) {
    const i = n - 1 - r;
    const s = solves[i];
    rows.push(
      <div key={s.id} className={`tp-solve-row${r % 2 === 0 ? ' odd' : ''}${i === bestIndex ? ' best' : ''}`}>
        <span className="idx">{i + 1}</span>
        <span className={`time${s.penalty === 'DNF' ? ' dnf' : ''}`}>{fmtSolveShort(s, precision)}</span>
        <span>{fmtAvg(ao5[i], precision)}</span>
        <span>{fmtAvg(ao12[i], precision)}</span>
      </div>,
    );
  }

  return (
    <section className="tp-panel tp-solves" aria-label="solves">
      <div className="tp-panel-title">
        <List size={14} /> solves
      </div>
      {n === 0 ? (
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
          <div className="tp-solve-scroll">{rows}</div>
        </>
      )}
    </section>
  );
});
