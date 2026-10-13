import { useEffect, useRef, useState } from 'react';

interface Props {
  /** cubing.js puzzle id, e.g. "3x3x3", "pyraminx", "megaminx", "square1", "clock", "skewb" */
  puzzle: string;
  /** scramble to apply */
  scramble: string;
  visualization?: '2D' | '3D';
  height?: number;
}

/**
 * Renders a scramble preview with cubing.js's <twisty-player>. cubing/twisty is large, so it is
 * lazy-loaded the first time a preview is shown.
 */
export function TwistyPreview({ puzzle, scramble, visualization = '2D', height = 180 }: Props) {
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
          player.style.height = `${height}px`;
          hostRef.current.appendChild(player);
          playerRef.current = player;
        }
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
