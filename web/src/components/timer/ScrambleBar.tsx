import { RefreshCw, WifiOff } from 'lucide-react';
import type { ScrambleItem } from '../../timer/useScrambleQueue';
import { noFocus } from './ConfigBar';

interface Props {
  scramble: ScrambleItem | null;
  onNext: () => void;
}

/** Font size steps by scramble length: 2x2/3x3 large, big cubes & megaminx smaller. */
function sizeFor(text: string): string {
  const n = text.length;
  if (n <= 50) return '1.75rem';
  if (n <= 90) return '1.5rem';
  if (n <= 160) return '1.25rem';
  if (n <= 320) return '1.05rem';
  if (n <= 600) return '0.95rem';
  return '0.85rem';
}

export function ScrambleBar({ scramble, onNext }: Props) {
  return (
    <div className="tp-scramble-wrap">
      {scramble ? (
        <div className="tp-scramble" style={{ ['--scramble-size' as string]: sizeFor(scramble.text) }} key={scramble.text}>
          {scramble.text}
        </div>
      ) : (
        <div className="tp-scramble tp-scramble-loading">
          generating scramble…
        </div>
      )}
      <div className="tp-scramble-actions">
        <button className="btn-text" onClick={onNext} aria-label="new scramble" data-tip="new scramble (tab)" {...noFocus}>
          <RefreshCw size={16} />
        </button>
        {scramble?.offline && (
          <span className="tp-scramble-hint" data-tip="the scramble service is unreachable — using random-move scrambles">
            <WifiOff size={12} /> offline scramble
          </span>
        )}
      </div>
    </div>
  );
}
