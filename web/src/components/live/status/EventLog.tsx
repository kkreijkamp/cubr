import { useState } from 'react';
import { ScrollIcon } from '@phosphor-icons/react';
import type { LogEntry } from './monitor';

const time = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
};

/** Timeline of what the monitor observed: new pods, outages, rollouts, load tests. Newest first. */
export function EventLog({ log }: { log: LogEntry[] }) {
  const [onlyImportant, setOnlyImportant] = useState(false);
  const rows = [...log].reverse().filter((e) => !onlyImportant || e.tone !== 'sub');
  return (
    <section className="card status-panel" aria-labelledby="log-title">
      <div className="live-section-title">
        <h3 className="h3" id="log-title">
          <ScrollIcon /> cluster events
        </h3>
        <button className={`btn-text small${onlyImportant ? ' active' : ''}`} onClick={() => setOnlyImportant((v) => !v)} style={{ padding: 0 }}>
          {onlyImportant ? 'showing changes only' : 'show changes only'}
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="panel-empty">nothing happened yet - scale a deployment or delete a pod and watch this list.</div>
      ) : (
        <ol className="event-log" aria-live="polite">
          {rows.map((e) => (
            <li key={e.id} className={e.tone}>
              <time className="t">{time(e.t)}</time>
              <span className="svc">{e.service ?? 'monitor'}</span>
              <span className="msg">{e.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
