import { EVENTS, getEvent } from '@cubetype/cubestats';

/** Buttons on the timer page never take focus on click, so Space can't re-trigger them. */
export const noFocus = { onMouseDown: (e: React.MouseEvent) => e.preventDefault() };

const shortLabel = (id: string) => (getEvent(id)?.short ?? id).toLowerCase();

interface Props {
  event: string;
  onEvent: (event: string) => void;
}

export function ConfigBar(p: Props) {
  return (
    <div className="config-bar tp-config">
      <div className="config-card tp-events-full" role="group" aria-label="event">
        {EVENTS.map((e) => (
          <button
            key={e.id}
            className={`btn-text${e.id === p.event ? ' active' : ''}`}
            onClick={() => p.onEvent(e.id)}
            aria-pressed={e.id === p.event}
            title={e.name}
            {...noFocus}
          >
            {shortLabel(e.id)}
          </button>
        ))}
      </div>
    </div>
  );
}
