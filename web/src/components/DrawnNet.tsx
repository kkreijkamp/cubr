import { useEffect, useMemo, useState } from 'react';
import { useSettings } from '../lib/settings';
import { buildDrawnNet, drawnColour, drawnKind, parseDrawing, type Drawing, type DrawnNet as Net } from '../lib/drawnNet';

/** drawings fetched and redrawn, by URL (a scramble's drawing never changes); the oldest go past 40 */
const nets = new Map<string, Promise<Net | null>>();

function netFor(url: string, event: string): Promise<Net | null> {
  let net = nets.get(url);
  if (!net) {
    net = fetch(url).then(async (res) => {
      if (!res.ok) throw new Error(`no drawing (${res.status})`);
      return buildDrawnNet(parseDrawing(await res.text()), drawnKind(event));
    });
    nets.set(url, net);
    net.catch(() => nets.delete(url));
    if (nets.size > 40) nets.delete(nets.keys().next().value!);
  }
  return net;
}

/** Fetches a drawing ahead of time (the next scramble's), so it shows at once when its turn comes. */
export function prefetchDrawnNet(url: string, event: string): void {
  netFor(url, event).catch(() => {});
}

interface Props {
  /** csTimer's drawing of the scramble (lib/api scrambleImageUrl) */
  url: string;
  event: string;
  height: number;
  /** csTimer can't draw this puzzle, or the scramble service can't be reached */
  onMissing: () => void;
  /** the drawing came, but not as shapes that can be redrawn: show it as it is */
  onUnreadable: () => void;
}

/**
 * csTimer's drawing of a scramble, for a puzzle cubing.js has no net for, redrawn as cubr's own
 * nets are (lib/drawnNet): rounded stickers on dark face plates, in cubr's colours or yours.
 */
export function DrawnNet({ url, event, height, onMissing, onUnreadable }: Props) {
  const [net, setNet] = useState<{ url: string; net: Net } | null>(null);

  useEffect(() => {
    let live = true;
    netFor(url, event).then(
      (n) => {
        if (!live) return;
        if (n) setNet({ url, net: n });
        else onUnreadable();
      },
      () => live && onMissing(),
    );
    return () => {
      live = false;
    };
  }, [url, event, onMissing, onUnreadable]);

  const shown = net?.url === url ? net.net : null;
  return <DrawnNetSvg net={shown} event={event} height={height} />;
}

/**
 * A redrawn net (lib/drawnNet), in cubr's colours or yours: csTimer's drawing of a scramble
 * (DrawnNet), or a net cubr works out itself (CuboidNet). Nothing while it's still on its way.
 */
export function DrawnNetSvg({ net, event, height }: { net: Net | null; event: string; height: number }) {
  const { stickerColours, customStickers } = useSettings();
  const fills = useMemo(() => {
    const custom = stickerColours === 'custom' ? customStickers : undefined;
    return net?.stickers.map((s) => drawnColour(s.fill, event, custom));
  }, [net, event, stickerColours, customStickers]);

  return (
    <div className="twisty-host" style={{ minHeight: height }}>
      {net && fills && (
        <svg className="scramble-net" viewBox={net.viewBox} style={{ height }} aria-hidden="true">
          {net.plates.map((p, i) => (
            <path key={i} className="plate" d={p.d} strokeWidth={p.stroke} strokeLinejoin="round" />
          ))}
          {net.stickers.map((s, i) => (
            <path key={i} d={s.d} fill={fills[i]} stroke={s.stroke ? fills[i] : undefined} strokeWidth={s.stroke || undefined} strokeLinejoin="round" />
          ))}
          {net.texts.map((t, i) => (
            <text key={i} className="tile-number" x={t.x} y={t.y} fontSize={t.size} textAnchor="middle" dominantBaseline="central">
              {t.text}
            </text>
          ))}
        </svg>
      )}
    </div>
  );
}

/** A cuboid's net (lib/cuboid), which neither cubing.js nor csTimer draws: worked out here, drawn as the others are. */
export function CuboidNet({ drawing, event, height }: { drawing: Drawing; event: string; height: number }) {
  const net = useMemo(() => buildDrawnNet(drawing, 'net'), [drawing]);
  return <DrawnNetSvg net={net} event={event} height={height} />;
}
