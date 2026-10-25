import { memo } from 'react';
import { IconChartBarPopular } from '@tabler/icons-react';
import { avgKey, formatTime, type Precision, type SessionStats } from '@cubetype/cubestats';
import type { Solve } from '../../lib/types';
import { fmtAvg, fmtSolveShort } from './statsUtil';
import { formatNumber } from '../../lib/format';

interface Props {
  stats: SessionStats;
  ns: number[];
  solves: Solve[];
  precision: Precision;
  onOpenAverage: (n: number, which: 'current' | 'best') => void;
  onOpenSolve: (index: number) => void;
}

function Cell({ value, onClick, best, label }: { value: string; onClick?: () => void; best?: boolean; label: string }) {
  if (value === '-') return <td className="na">-</td>;
  if (!onClick) return <td className={best ? 'best' : undefined}>{value}</td>;
  return (
    <td className={best ? 'best' : undefined}>
      <button className="tp-cell-btn" onClick={onClick} aria-label={label} onMouseDown={(e) => e.preventDefault()}>
        {value}
      </button>
    </td>
  );
}

/** current / best table for single + the configured averages, plus count / mean / standard deviation. */
export const StatsPanel = memo(function StatsPanel({ stats, ns, solves, precision, onOpenAverage, onOpenSolve }: Props) {
  const last = solves.length ? solves[solves.length - 1] : null;
  const sigma = stats.sd === null ? '-' : (stats.sd / 1000).toFixed(2);
  return (
    <section className="tp-panel" aria-label="session statistics">
      <div className="tp-panel-title">
        <IconChartBarPopular size={14} /> stats
      </div>
      <table className="tp-stats">
        <thead>
          <tr>
            <th />
            <th>current</th>
            <th>best</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">time</th>
            <Cell
              value={last ? fmtSolveShort(last, precision) : '-'}
              onClick={last ? () => onOpenSolve(solves.length - 1) : undefined}
              label="open latest solve"
            />
            <Cell
              best
              value={formatTime(stats.best, precision)}
              onClick={stats.bestIndex !== null ? () => onOpenSolve(stats.bestIndex!) : undefined}
              label="open best single"
            />
          </tr>
          {ns.map((n) => {
            const key = avgKey(n);
            const line = stats.averages[key];
            return (
              <tr key={key}>
                <th scope="row">{key}</th>
                <Cell value={fmtAvg(line?.current, precision)} onClick={() => onOpenAverage(n, 'current')} label={`current ${key} details`} />
                <Cell best value={fmtAvg(line?.best, precision)} onClick={() => onOpenAverage(n, 'best')} label={`best ${key} details`} />
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="tp-stat-summary">
        <div className="stat">
          <div className="label">solves</div>
          <div className="value text" data-tip={stats.dnfs ? `${stats.dnfs} DNF` : undefined}>
            {formatNumber(stats.solved)}
            {stats.count !== stats.solved && <span className="tp-of">/{formatNumber(stats.count)}</span>}
          </div>
        </div>
        <div className="stat">
          <div className="label">mean</div>
          <div className="value text">{fmtAvg(stats.mean, precision)}</div>
        </div>
        <div className="stat">
          <div className="label">{'\u03c3'}</div>
          <div className="value text">{sigma}</div>
        </div>
      </div>
    </section>
  );
});
