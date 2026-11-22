import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { TwistyPlayer } from 'cubing/twisty';
import { getEvent, splitRelay } from '@cubr/cubestats';
import { preview3D, type Puzzle3D } from '../lib/cubing3d';
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
  /** the scramble's type (cubestats scrambleTypes), the event's default when absent: in 3D, one in csTimer's notation is translated */
  scrambleType?: string;
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
 * (DrawnNet), and a relay is its puzzles' own previews. In 3D, a scramble in csTimer's notation of a
 * puzzle cubing.js has a model of (its own, or one it builds from the puzzle's geometry) is
 * translated (lib/cubing3d).
 */
export function TwistyPreview(props: Props) {
  const { puzzle, scramble, visualization = '2D', height = 180, fit, event, imageUrl, scrambleType } = props;
  // the puzzle whose 2D net couldn't be built (its <twisty-player> instead), the scramble cubing.js
  // couldn't read, and the translated one it turned down (then shown as it would be untranslated)
  const [netFailed, setNetFailed] = useState<string | null>(null);
  const [unreadable, setUnreadable] = useState<string | null>(null);
  const [untranslatable, setUntranslatable] = useState<string | null>(null);
  const onNetError = useCallback(() => setNetFailed(puzzle), [puzzle]);
  const onUnreadable = useCallback(() => setUnreadable(`${puzzle}\n${scramble}`), [puzzle, scramble]);
  const onUntranslatable = useCallback(() => setUntranslatable(scramble), [scramble]);
  const translated = visualization === '3D' && event && untranslatable !== scramble ? preview3D(event, scrambleType, scramble) : null;
  if (translated) {
    const p = translated.puzzle;
    return <TwistyPlayerPreview key={'id' in p ? p.id : p.description} puzzle={p} scramble={translated.alg} visualization="3D" height={height} fit={fit} onUnreadable={onUntranslatable} />;
  }
  if (puzzle === null || unreadable === `${puzzle}\n${scramble}`) {
    const relay = puzzle === null && event ? splitRelay(event, scramble) : null;
    if (relay) return <RelayPreview parts={relay} height={height} visualization={visualization} />;
    const what = puzzle === null ? 'puzzle' : 'scramble';
    return imageUrl ? <Drawn key={imageUrl} url={imageUrl} event={event} what={what} height={height} /> : <NoPreview what={what} height={height} />;
  }
  if (visualization === '2D' && puzzle !== 'clock' && netFailed !== puzzle) {
    return <ScrambleNet puzzle={puzzle} scramble={scramble} height={height} fit={fit} onError={onNetError} onUnreadable={onUnreadable} />;
  }
  return <TwistyPlayerPreview puzzle={{ id: puzzle }} scramble={scramble} visualization={visualization} height={height} fit={fit} onUnreadable={onUnreadable} />;
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

/** A relay: each puzzle's own preview under its label (as its scramble line starts), as many to a row as fit best. */
function RelayPreview({ parts, height, visualization }: { parts: { label: string; event: string; scramble: string }[]; height: number; visualization: '2D' | '3D' }) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref);
  const cols = relayColumns(parts.length, width || 2 * height, height, RELAY_LABEL + RELAY_ROW_GAP, visualization === '3D' ? 1 : 0.75);
  const rows = Math.ceil(parts.length / cols);
  const each = Math.max(24, Math.floor((height - (rows - 1) * RELAY_ROW_GAP) / rows - RELAY_LABEL));
  return (
    <div ref={ref} className="relay-preview" style={{ minHeight: height, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {parts.map((p, i) => (
        <div key={i} className="relay-part">
          <span className="relay-label">{p.label}</span>
          <TwistyPreview puzzle={getEvent(p.event)?.puzzle ?? null} scramble={p.scramble} visualization={visualization} height={each} fit />
        </div>
      ))}
    </div>
  );
}

interface PlayerProps {
  puzzle: Puzzle3D;
  scramble: string;
  visualization: '2D' | '3D';
  height: number;
  fit?: boolean;
  /** cubing.js can't read the scramble (csTimer's own notation): it would show the solved puzzle */
  onUnreadable: () => void;
}

/** cubing/twisty is large, so it is lazy-loaded the first time a preview is shown */
function TwistyPlayerPreview({ puzzle, scramble, visualization, height, fit, onUnreadable }: PlayerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<HTMLElement | null>(null);
  const [failed, setFailed] = useState(false);
  const id = 'id' in puzzle ? puzzle.id : null;
  const description = 'description' in puzzle ? puzzle.description : null;

  useEffect(() => {
    let cancelled = false;
    Promise.all([import('cubing/twisty'), import('cubing/puzzles')])
      .then(async ([, { puzzles }]) => {
        const readable = async (kpuzzle: Promise<{ defaultPattern(): { applyAlg(alg: string): unknown } }>) => {
          try {
            (await kpuzzle).defaultPattern().applyAlg(scramble);
            return true;
          } catch {
            if (!cancelled) onUnreadable();
            return false;
          }
        };
        if (id !== null && !(await readable(puzzles[id].kpuzzle()))) return;
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
        // fitted to the width, at most `height` tall: a clock's two faces side by side, anything else about square
        if (fit) Object.assign(player.style, { height: 'auto', aspectRatio: id === 'clock' ? '2 / 1' : '1 / 1', maxHeight: `${height}px` });
        else player.style.height = `${height}px`;
        if (id !== null) player.setAttribute('puzzle', id);
        else {
          // a puzzle cubing.js builds from its geometry: its moves are known once it's built
          player.setAttribute('experimental-puzzle-description', description!);
          if (!(await readable((player as TwistyPlayer).experimentalModel.kpuzzle.get())) || cancelled) return;
        }
        player.setAttribute('visualization', visualization);
        player.setAttribute('experimental-setup-alg', scramble);
        player.setAttribute('alg', '');
      })
      .catch(() => setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [id, description, scramble, visualization, height, fit, onUnreadable]);

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
