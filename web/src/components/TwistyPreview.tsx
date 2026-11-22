import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { getEvent, splitRelay } from '@cubr/cubestats';
import { redrawable, relayColumns } from '../lib/drawnNet';
import { DrawnNet } from './DrawnNet';
import { ScrambleNet } from './ScrambleNet';

interface Props {
  /** cubing.js puzzle id, e.g. "3x3x3", "pyraminx", "megaminx", "square1", "clock", "skewb"; null: cubing.js can't draw it */
  puzzle: string | null;
  /** scramble to apply */
  scramble: string;
  visualization?: '2D' | '3D';
  height?: number;
  /** sized by the box's width, at most `height` tall, rather than `height` tall (a relay's puzzles, each under its label) */
  fit?: boolean;
  /** the event: a relay's puzzles are drawn one by one, and csTimer's drawing is coloured for it */
  event?: string;
  /**
   * csTimer's drawing of the scramble (lib/api scrambleImageUrl), for a puzzle cubing.js can't draw
   * or a scramble it can't read (a type in csTimer's own notation)
   */
  imageUrl?: string;
}

/**
 * A scramble preview: in 2D cubr's own flat net (ScrambleNet), in 3D cubing.js's <twisty-player>.
 * The clock's net is dials and hands rather than stickers, so cubing.js draws that too. A puzzle
 * cubing.js can't draw, or a scramble it can't read, is csTimer's drawing redrawn as a cubr net
 * (DrawnNet), and a relay is its puzzles' own nets.
 */
export function TwistyPreview(props: Props) {
  const { puzzle, scramble, visualization = '2D', height = 180, fit, event, imageUrl } = props;
  // the puzzle whose 2D net couldn't be built (its <twisty-player> instead), and the scramble cubing.js couldn't read
  const [netFailed, setNetFailed] = useState<string | null>(null);
  const [unreadable, setUnreadable] = useState<string | null>(null);
  const onNetError = useCallback(() => setNetFailed(puzzle), [puzzle]);
  const onUnreadable = useCallback(() => setUnreadable(`${puzzle}\n${scramble}`), [puzzle, scramble]);
  if (puzzle === null || unreadable === `${puzzle}\n${scramble}`) {
    const relay = puzzle === null && event ? splitRelay(event, scramble) : null;
    if (relay) return <RelayPreview parts={relay} height={height} />;
    const what = puzzle === null ? 'puzzle' : 'scramble';
    return imageUrl ? <Drawn key={imageUrl} url={imageUrl} event={event} what={what} height={height} /> : <NoPreview what={what} height={height} />;
  }
  if (visualization === '2D' && puzzle !== 'clock' && netFailed !== puzzle) {
    return <ScrambleNet puzzle={puzzle} scramble={scramble} height={height} fit={fit} onError={onNetError} onUnreadable={onUnreadable} />;
  }
  return <TwistyPlayerPreview {...props} puzzle={puzzle} onUnreadable={onUnreadable} />;
}

function NoPreview({ what, height }: { what: 'puzzle' | 'scramble'; height: number }) {
  return (
    <div className="twisty-host twisty-none" style={{ minHeight: height }}>
      no preview for this {what} yet
    </div>
  );
}

/**
 * csTimer's drawing: as a cubr net, or as it came where it can't be redrawn (a clock's dials, or
 * shapes that can't be read); none where csTimer can't draw it (404) or can't be reached.
 */
function Drawn({ url, event, what, height }: { url: string; event?: string; what: 'puzzle' | 'scramble'; height: number }) {
  const [mode, setMode] = useState<'net' | 'image' | 'none'>(event && redrawable(event) ? 'net' : 'image');
  const onMissing = useCallback(() => setMode('none'), []);
  const onUnreadable = useCallback(() => setMode('image'), []);
  if (mode === 'none') return <NoPreview what={what} height={height} />;
  if (mode === 'image' || !event) return <DrawnImage url={url} height={height} onError={onMissing} />;
  return <DrawnNet url={url} event={event} height={height} onMissing={onMissing} onUnreadable={onUnreadable} />;
}

/** csTimer's drawing as it is */
function DrawnImage({ url, height, onError }: { url: string; height: number; onError: () => void }) {
  return (
    <div className="twisty-host twisty-drawn" style={{ minHeight: height }}>
      <img src={url} alt="" style={{ height }} onError={onError} draggable={false} />
    </div>
  );
}

/** the label line over each of a relay's puzzles, and the gap between rows, in px (.relay-label, .relay-preview) */
const RELAY_LABEL = 16;
const RELAY_ROW_GAP = 4;

function useWidth(ref: RefObject<HTMLElement>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // whole pixels, and only real changes
    const measure = () => setWidth((prev) => (Math.abs(el.clientWidth - prev) >= 2 ? el.clientWidth : prev));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/** A relay: each puzzle's own 2D preview under its label (as its scramble line starts), as many to a row as fit best. */
function RelayPreview({ parts, height }: { parts: { label: string; event: string; scramble: string }[]; height: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref);
  const cols = relayColumns(parts.length, width || 2 * height, height, RELAY_LABEL + RELAY_ROW_GAP);
  const rows = Math.ceil(parts.length / cols);
  const each = Math.max(24, Math.floor((height - (rows - 1) * RELAY_ROW_GAP) / rows - RELAY_LABEL));
  return (
    <div ref={ref} className="relay-preview" style={{ minHeight: height, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {parts.map((p, i) => (
        <div key={i} className="relay-part">
          <span className="relay-label">{p.label}</span>
          <TwistyPreview puzzle={getEvent(p.event)?.puzzle ?? null} scramble={p.scramble} height={each} fit />
        </div>
      ))}
    </div>
  );
}

/** cubing/twisty is large, so it is lazy-loaded the first time a preview is shown */
function TwistyPlayerPreview({ puzzle, scramble, visualization = '2D', height = 180, fit, onUnreadable }: Props & { puzzle: string; onUnreadable: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<HTMLElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([import('cubing/twisty'), import('cubing/puzzles')])
      .then(async ([, { puzzles }]) => {
        // a scramble cubing.js can't read (csTimer's own notation) would show the solved puzzle
        try {
          (await puzzles[puzzle].kpuzzle()).defaultPattern().applyAlg(scramble);
        } catch {
          if (!cancelled) onUnreadable();
          return;
        }
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
        // fitted to the width: as wide as its drawing is (a clock's two faces side by side), at most `height` tall
        if (fit) Object.assign(player.style, { height: 'auto', aspectRatio: '2 / 1', maxHeight: `${height}px` });
        else player.style.height = `${height}px`;
        player.setAttribute('puzzle', puzzle);
        player.setAttribute('visualization', visualization);
        player.setAttribute('experimental-setup-alg', scramble);
        player.setAttribute('alg', '');
      })
      .catch(() => setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [puzzle, scramble, visualization, height, fit, onUnreadable]);

  useEffect(
    () => () => {
      playerRef.current?.remove();
      playerRef.current = null;
    },
    [],
  );

  if (failed) return null;
  return <div ref={hostRef} className="twisty-host" style={fit ? undefined : { minHeight: height }} />;
}
