import { Square2StackIcon } from '@heroicons/react/24/outline';
import type { Precision } from '@cubr/cubestats';
import { Modal } from '../Modal';
import { toast } from '../../lib/toast';
import { formatDateTime } from '../../lib/format';
import { copyText } from './feedback';
import { averageReport, fmtAvg, fmtSolveShort, type AverageWindow } from './statsUtil';

interface Props {
  label: string;
  window: AverageWindow;
  precision: Precision;
  onOpenSolve: (index: number) => void;
  onClose: () => void;
}

/** csTimer-style average breakdown: trimmed (best/worst) solves are shown in parentheses. */
export function AverageModal({ label, window: w, precision, onOpenSolve, onClose }: Props) {
  const copy = async () => {
    if (await copyText(averageReport(label, w, precision))) toast.success('copied to clipboard', { durationMs: 1500 });
    else toast.error("couldn't access the clipboard");
  };
  const from = w.solves[0];
  const to = w.solves[w.solves.length - 1];
  return (
    <Modal title={label} onClose={onClose} wide>
      <div className="tp-avg-head">
        <div className="stat lg">
          <div className="value">{fmtAvg(w.value, precision)}</div>
        </div>
        <div className="tp-avg-meta">
          <span>
            solves {w.start + 1}-{w.start + w.solves.length}
          </span>
          {from && to && (
            <span>
              {formatDateTime(from.createdAt)} -&gt; {formatDateTime(to.createdAt)}
            </span>
          )}
          <button className="btn small" onClick={copy}>
            <Square2StackIcon width={14} height={14} /> copy as text
          </button>
        </div>
      </div>
      <div className="tp-avg-list">
        {w.solves.map((s, i) => {
          const t = fmtSolveShort(s, precision);
          const trimmed = w.trimmed.has(i);
          return (
            <button key={s.id} className={`tp-avg-row${trimmed ? ' trimmed' : ''}`} onClick={() => onOpenSolve(w.start + i)}>
              <span className="n">{i + 1}.</span>
              <span className="t">{trimmed ? `(${t})` : t}</span>
              <span className="s">{s.scramble.replace(/\n/g, ' ')}</span>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
