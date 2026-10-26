import { useState } from 'react';
import { eventLabel, plural } from './util';
import { formatNumber } from '../../lib/format';

/** At most this many segments: the smallest events fold into "other" past it. */
const MAX_SEGMENTS = 6;
const R = 50;
const RING = 9;
const C = 2 * Math.PI * R;
/** gap between segments, in ring units (~2px at the drawn size) */
const GAP = 2.4;
/** the events that aren't selected: one grey, lighter down the list (from the theme's sub colour) */
const SHADES = [88, 70, 56, 45, 36, 28];

interface Slice {
  key: string;
  label: string;
  solves: number;
  /** the event id, or null for "other" */
  event: string | null;
}

function slices(events: { event: string; solves: number }[]): Slice[] {
  const sorted = events.filter((e) => e.solves > 0).sort((a, b) => b.solves - a.solves);
  const head = sorted.length > MAX_SEGMENTS ? sorted.slice(0, MAX_SEGMENTS - 1) : sorted;
  const tail = sorted.slice(head.length);
  const out: Slice[] = head.map((e) => ({ key: e.event, label: eventLabel(e.event), solves: e.solves, event: e.event }));
  if (tail.length) out.push({ key: 'other', label: `${tail.length} more`, solves: tail.reduce((a, e) => a + e.solves, 0), event: null });
  return out;
}

const pct = (part: number, total: number) => {
  const p = (part / total) * 100;
  return p >= 10 || p === 0 ? `${Math.round(p)}%` : p < 1 ? '<1%' : `${p.toFixed(1)}%`;
};

/**
 * The share of solves per event as a thin ring, with a legend beside it. The selected event (the
 * profile's tab) wears the accent colour, the rest are greys; a segment or legend row picks that
 * event. The middle reads out the hovered event (or the selected one).
 */
export function EventDonut({ events, selected, onSelect }: { events: { event: string; solves: number }[]; selected: string; onSelect: (event: string) => void }) {
  const [hover, setHover] = useState<string | null>(null);
  const list = slices(events);
  const total = list.reduce((a, s) => a + s.solves, 0);
  if (list.length < 2 || total === 0) return null;

  const focus = list.find((s) => s.key === hover) ?? list.find((s) => s.event === selected) ?? list[0];
  // each event keeps its grey (by its place in the list) when the selection moves - only the accent moves
  const colour = new Map(list.map((s, i) => [s.key, s.event === selected ? 'var(--main-color)' : `color-mix(in srgb, var(--sub-color) ${SHADES[i] ?? 24}%, var(--sub-alt-color))`]));

  let at = 0;
  const arcs = list.map((s) => {
    const len = (s.solves / total) * C;
    const arc = { s, dash: Math.max(0.6, len - GAP), offset: at };
    at += len;
    return arc;
  });

  return (
    <div className="pf-donut" onMouseLeave={() => setHover(null)}>
      <div className="pf-donut-ring">
        <svg viewBox="0 0 120 120" role="img" aria-label={`solves by event: ${list.map((s) => `${s.label} ${pct(s.solves, total)}`).join(', ')}`}>
          <g transform="rotate(-90 60 60)">
            {arcs.map(({ s, dash, offset }) => (
              <circle
                key={s.key}
                cx="60"
                cy="60"
                r={R}
                fill="none"
                stroke={colour.get(s.key)}
                strokeWidth={s.key === focus.key ? RING + 3 : RING}
                strokeDasharray={`${dash} ${C - dash}`}
                strokeDashoffset={-offset}
                className={s.event ? 'seg pick' : 'seg'}
                onMouseEnter={() => setHover(s.key)}
                onClick={() => s.event && onSelect(s.event)}
              />
            ))}
          </g>
        </svg>
        <div className="pf-donut-mid" aria-hidden="true">
          <span className="p">{pct(focus.solves, total)}</span>
          <span className="l">{focus.label}</span>
        </div>
      </div>
      <ul className="pf-donut-legend">
        {list.map((s) => (
          <li key={s.key}>
            <button
              type="button"
              className={`${s.event === selected ? 'on' : ''}${s.key === hover ? ' hover' : ''}`}
              disabled={!s.event}
              onMouseEnter={() => setHover(s.key)}
              onFocus={() => setHover(s.key)}
              onBlur={() => setHover(null)}
              onClick={() => s.event && onSelect(s.event)}
              data-tip={plural(s.solves, 'solve')}
              aria-label={`${s.label}: ${pct(s.solves, total)} (${formatNumber(s.solves)} solves)`}
            >
              <i style={{ background: colour.get(s.key) }} />
              <span className="l">{s.label}</span>
              <span className="p">{pct(s.solves, total)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
