import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrambleNet } from './ScrambleNet';

interface Props {
  /** cubing.js puzzle id, e.g. "3x3x3", "pyraminx", "megaminx", "square1", "clock", "skewb" */
  puzzle: string;
  /** scramble to apply */
  scramble: string;
  visualization?: '2D' | '3D';
  height?: number;
}

/**
 * A scramble preview: in 2D cubr's own flat net (ScrambleNet), in 3D cubing.js's <twisty-player>.
 * The clock's net is dials and hands rather than stickers, so cubing.js draws that too.
 */
export function TwistyPreview(props: Props) {
  const [netFailed, setNetFailed] = useState(false);
  const onNetError = useCallback(() => setNetFailed(true), []);
  const { puzzle, scramble, visualization = '2D', height = 180 } = props;
  if (visualization === '2D' && puzzle !== 'clock' && !netFailed) {
    return <ScrambleNet puzzle={puzzle} scramble={scramble} height={height} onError={onNetError} />;
  }
  return <TwistyPlayerPreview {...props} />;
}

/** cubing/twisty is large, so it is lazy-loaded the first time a preview is shown */
function TwistyPlayerPreview({ puzzle, scramble, visualization = '2D', height = 180 }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<HTMLElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    import('cubing/twisty')
      .then(() => {
        if (cancelled || !hostRef.current) return;
        let player = playerRef.current;
        if (!player) {
          player = document.createElement('twisty-player');
          player.setAttribute('control-panel', 'none');
          player.setAttribute('background', 'none');
          player.setAttribute('hint-facelets', 'none');
          player.setAttribute('back-view', 'none');
          player.style.width = '100%';
          hostRef.current.appendChild(player);
          playerRef.current = player;
        }
        player.style.height = `${height}px`;
        player.setAttribute('puzzle', puzzle);
        player.setAttribute('visualization', visualization);
        player.setAttribute('experimental-setup-alg', scramble);
        player.setAttribute('alg', '');
      })
      .catch(() => setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [puzzle, scramble, visualization, height]);

  useEffect(
    () => () => {
      playerRef.current?.remove();
      playerRef.current = null;
    },
    [],
  );

  if (failed) return null;
  return <div ref={hostRef} className="twisty-host" style={{ minHeight: height }} />;
}
