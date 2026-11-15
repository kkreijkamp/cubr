// Small presentational pieces shared by the live pages (daily, race, wca).
import { useState, type ReactNode } from 'react';
import { CheckIcon, Square2StackIcon } from '@heroicons/react/24/outline';
import { getEvent } from '@cubr/cubestats';
import { copyText } from './hooks';
import './live.css';

/** Monkeytype config-card of text buttons; the active one is main-coloured. */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: { value: T; label: ReactNode; tip?: string; disabled?: boolean }[];
  value: T;
  onChange: (v: T) => void;
  label?: string;
  className?: string;
}) {
  return (
    <div className={`config-card live-seg ${className ?? ''}`} role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          role="tab"
          aria-selected={o.value === value}
          className={`btn-text${o.value === value ? ' active' : ''}`}
          onClick={(e) => {
            onChange(o.value);
            (e.currentTarget as HTMLButtonElement).blur();
          }}
          disabled={o.disabled}
          data-tip={o.tip}
          data-tip-pos={o.tip ? 'down' : undefined}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Event chips using the short WCA names ("3x3", "Pyra", ...). */
export function EventPicker({ events, value, onChange, label = 'event' }: { events: string[]; value: string; onChange: (e: string) => void; label?: string }) {
  return (
    <Segmented
      label={label}
      value={value}
      onChange={onChange}
      options={events.map((id) => ({ value: id, label: getEvent(id)?.short ?? id, tip: getEvent(id)?.name }))}
    />
  );
}

/** Scramble text sized to its length, with a copy button. */
export function ScrambleText({ scramble, event, muted, actions }: { scramble: string | null; event: string; muted?: boolean; actions?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const len = scramble?.length ?? 0;
  const size = len <= 40 ? 1.6 : len <= 70 ? 1.35 : len <= 130 ? 1.1 : len <= 260 ? 0.95 : 0.8;
  return (
    <div className={`live-scramble${muted ? ' muted' : ''}${event === 'minx' ? ' minx' : ''}`}>
      <div className="text" style={{ fontSize: `${size}rem` }}>
        {scramble ?? '\u00a0'}
      </div>
      {scramble && (
        <div className="actions">
          {actions}
          <button
            className="btn-text"
            aria-label="copy scramble"
            data-tip={copied ? 'copied!' : 'copy scramble'}
            onClick={async (e) => {
              (e.currentTarget as HTMLButtonElement).blur();
              if (await copyText(scramble)) {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }
            }}
          >
            {copied ? <CheckIcon width={16} height={16} /> : <Square2StackIcon width={16} height={16} />}
          </button>
        </div>
      )}
    </div>
  );
}

export type DotState = 'up' | 'down' | 'degraded' | 'pending' | 'idle' | 'inspecting' | 'solving' | 'done' | 'offline';

/** Status dot; "live" states get a soft pulse ring. */
export function Dot({ state, title, pulse }: { state: DotState; title?: string; pulse?: boolean }) {
  return <span className={`live-dot ${state}${pulse ? ' pulse' : ''}`} title={title} aria-label={title ?? state} role="img" />;
}

/**
 * Tiny inline SVG sparkline. `null` values are gaps (drawn as error ticks on the baseline), so a
 * service outage is visible in the latency history.
 */
export function Sparkline({ values, height = 22, max: maxIn, className }: { values: (number | null)[]; height?: number; max?: number; className?: string }) {
  const w = 120;
  const n = Math.max(values.length, 2);
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const max = maxIn ?? Math.max(1, ...finite) * 1.15;
  const x = (i: number) => (i / (n - 1)) * w;
  const y = (v: number) => height - 2 - (Math.min(v, max) / max) * (height - 4);
  const segments: string[] = [];
  let cur = '';
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      if (cur) segments.push(cur);
      cur = '';
      return;
    }
    cur += `${cur ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
  });
  if (cur) segments.push(cur);
  const last = values.length ? values[values.length - 1] : null;
  return (
    <svg className={`live-spark ${className ?? ''}`} viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" height={height} aria-hidden="true">
      {segments.map((d, i) => (
        <path key={i} d={d} fill="none" vectorEffect="non-scaling-stroke" />
      ))}
      {values.map((v, i) => (v === null ? <rect key={`g${i}`} className="gap" x={x(i) - 0.6} y={height - 3} width={1.2} height={3} /> : null))}
      {last !== null && Number.isFinite(last) && <circle className="tip" cx={x(values.length - 1)} cy={y(last)} r={1.6} />}
    </svg>
  );
}

/** Banner for a service that is temporarily unavailable. */
export function Notice({ icon, children, tone = 'sub', action }: { icon?: ReactNode; children: ReactNode; tone?: 'sub' | 'error' | 'main'; action?: ReactNode }) {
  return (
    <div className={`live-notice ${tone}`} role="status">
      {icon}
      <div className="body">{children}</div>
      {action}
    </div>
  );
}
