import { memo } from 'react';
import { ChartNoAxesColumn } from 'lucide-react';
import { avgKey, formatTime, type Precision, type SessionStats } from '@cubetype/cubestats';
import type { Solve } from '../../lib/types';
import { fmtAvg, fmtSolveShort } from './statsUtil';
import { formatNumber } from '../../lib/format';

interface Props {
  stats: SessionStats;
  ns: number[];
  solves: Solve[];
  precision: Precision;
}

function Cell({ value, best }: { value: string; best?: boolean }) {
  if (value === '-') return <td className="na">-</td>;
  return <td className={best ? 'best' : undefined}>{value}</td>;
}

/** current / best table for single + the configured averages, plus count / mean / σ. */
export const StatsPanel = memo(function StatsPanel({ stats, ns, solves, precision }: Props) {
  const last = solves.length ? solves[solves.length - 1] : null;
  const sigma = stats.sd === null ? '-' : (stats.sd / 1000).toFixed(2);
  return (
    <section className="tp-panel" aria-label="session statistics">
      <div className="tp-panel-title">
        <ChartNoAxesColumn size={14} /> stats
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
            <Cell value={last ? fmtSolveShort(last, precision) : '-'} />
            <Cell best value={formatTime(stats.best, precision)} />
          </tr>
          {ns.map((n) => {
            const key = avgKey(n);
            const line = stats.averages[key];
            return (
              <tr key={key}>
                <th scope="row">{key}</th>
                <Cell value={fmtAvg(line?.current, precision)} />
                <Cell best value={fmtAvg(line?.best, precision)} />
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
          <div className="label">σ</div>
          <div className="value text">{sigma}</div>
        </div>
      </div>
    </section>
  );
});
