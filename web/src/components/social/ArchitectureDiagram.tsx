import { useEffect, useId, useRef, useState } from 'react';

// Themed inline-SVG architecture diagram. Colours come only from theme tokens (CSS classes in
// about.css). Two hand-tuned layouts: "wide" (desktop) and "tall" (phones) share one renderer.

type Pt = [number, number];
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
type ServiceId = 'web' | 'auth' | 'scramble' | 'wca' | 'solve' | 'stats' | 'leaderboard' | 'race';

const SERVICES: { id: ServiceId; sub: string; hpa?: boolean }[] = [
  { id: 'web', sub: 'nginx · spa', hpa: true },
  { id: 'auth', sub: 'jwt · profiles' },
  { id: 'scramble', sub: 'cubing.js pool', hpa: true },
  { id: 'wca', sub: 'results export' },
  { id: 'solve', sub: 'crud · outbox', hpa: true },
  { id: 'stats', sub: 'read model' },
  { id: 'leaderboard', sub: 'sorted sets' },
  { id: 'race', sub: 'websockets', hpa: true },
];

interface Layout {
  w: number;
  h: number;
  title: number;
  sub: number;
  browser: Box;
  lb: Box;
  lbSub: string;
  protocol: Pt;
  cluster: Box;
  clusterLabel: string;
  services: Record<ServiceId, Box>;
  /** request-path wires without arrowheads */
  wires: Pt[][];
  /** request-path wires ending in an arrowhead */
  arrows: Pt[][];
  dots: Pt[];
  pg: Box;
  pgTitle: string;
  pgSub: string;
  primary: Box;
  replica: Box;
  repl: Pt[];
  replLabel: { x: number; y: number; anchor: 'start' | 'middle' };
  redis: Box;
  redisTitle: string;
  redisSub: string;
  segs: { streams: Box; cache: Box; boards: Box };
  /** event flow: solve → stream, stream → stats, stream → leaderboard */
  flows: Pt[][];
  chips: Box[];
}

const CHIPS = [
  { t: 'hpa autoscaling', s: 'scramble · solve · web · race on cpu' },
  { t: 'rolling updates', s: 'maxSurge 1 · maxUnavailable 0' },
  { t: 'self-healing', s: 'probes · pdb · 2+ replicas each' },
];

function wideLayout(): Layout {
  const services = {} as Record<ServiceId, Box>;
  SERVICES.forEach((s, i) => (services[s.id] = { x: 41 + i * 116, y: 246, w: 106, h: 78 }));
  const cx = (id: ServiceId) => services[id].x + services[id].w / 2;
  const dataIds = SERVICES.filter((s) => s.id !== 'web').map((s) => s.id);
  return {
    w: 1000,
    h: 664,
    title: 14,
    sub: 11,
    browser: { x: 390, y: 8, w: 220, h: 58 },
    lb: { x: 250, y: 108, w: 500, h: 52 },
    lbSub: 'http · /api/* → services · /socket.io → race',
    protocol: [510, 92],
    cluster: { x: 16, y: 190, w: 968, h: 460 },
    clusterLabel: 'gke cluster · namespace cubetype',
    services,
    wires: [
      [
        [500, 160],
        [500, 226],
      ],
      [
        [cx('web'), 226],
        [cx('race'), 226],
      ],
      ...dataIds.map((id): Pt[] => [
        [cx(id), 324],
        [cx(id), 376],
      ]),
      [
        [cx('auth'), 376],
        [cx('race'), 376],
      ],
    ],
    arrows: [
      [
        [500, 66],
        [500, 106],
      ],
      ...SERVICES.map((s): Pt[] => [
        [cx(s.id), 226],
        [cx(s.id), 244],
      ]),
      [
        [255, 376],
        [255, 412],
      ],
      [
        [cx('race'), 376],
        [cx('race'), 412],
      ],
    ],
    dots: [[500, 226] as Pt, ...SERVICES.map((s): Pt => [cx(s.id), 226]), ...dataIds.map((id): Pt => [cx(id), 376]), [255, 376]],
    pg: { x: 41, y: 414, w: 429, h: 152 },
    pgTitle: 'postgresql 17 · cloudnativepg',
    pgSub: 'schema per service · automatic failover',
    primary: { x: 72, y: 430, w: 132, h: 70 },
    replica: { x: 308, y: 430, w: 132, h: 70 },
    repl: [
      [208, 474],
      [304, 474],
    ],
    replLabel: { x: 256, y: 464, anchor: 'middle' },
    redis: { x: 530, y: 414, w: 429, h: 152 },
    redisTitle: 'redis 7 · statefulset',
    redisSub: 'event bus · cache · leaderboards · race state',
    segs: {
      streams: { x: 544, y: 430, w: 126, h: 70 },
      cache: { x: 682, y: 430, w: 126, h: 70 },
      boards: { x: 820, y: 430, w: 126, h: 70 },
    },
    flows: [
      [
        [548, 324],
        [548, 404],
        [590, 404],
        [590, 428],
      ],
      [
        [620, 430],
        [620, 394],
        [684, 394],
        [684, 326],
      ],
      [
        [640, 430],
        [640, 410],
        [800, 410],
        [800, 326],
      ],
    ],
    chips: [0, 1, 2].map((i) => ({ x: 41 + i * 310, y: 588, w: 298, h: 46 })),
  };
}

function tallLayout(): Layout {
  const order: ServiceId[][] = [
    ['web', 'auth'],
    ['scramble', 'wca'],
    ['solve', 'stats'],
    ['leaderboard', 'race'],
  ];
  const services = {} as Record<ServiceId, Box>;
  order.forEach((row, r) => row.forEach((id, c) => (services[id] = { x: c === 0 ? 24 : 194, y: 214 + r * 74, w: 142, h: 60 })));
  const rowY = order.map((_, r) => 214 + r * 74 + 30);
  return {
    w: 360,
    h: 980,
    title: 13,
    sub: 10,
    browser: { x: 90, y: 8, w: 180, h: 54 },
    lb: { x: 24, y: 100, w: 312, h: 52 },
    lbSub: 'gke ingress · path routing',
    protocol: [190, 86],
    cluster: { x: 8, y: 176, w: 344, h: 796 },
    clusterLabel: 'gke cluster · ns cubetype',
    services,
    wires: [
      [
        [180, 152],
        [180, 640],
      ],
    ],
    arrows: [
      [
        [180, 62],
        [180, 98],
      ],
      ...rowY.flatMap((y): Pt[][] => [
        [
          [180, y],
          [168, y],
        ],
        [
          [180, y],
          [192, y],
        ],
      ]),
      [
        [180, 640],
        [168, 640],
      ],
      [
        [180, 640],
        [192, 640],
      ],
    ],
    dots: [...rowY.map((y): Pt => [180, y]), [180, 640]],
    pg: { x: 24, y: 560, w: 142, h: 230 },
    pgTitle: 'postgresql 17',
    pgSub: 'cloudnativepg',
    primary: { x: 44, y: 578, w: 102, h: 58 },
    replica: { x: 44, y: 676, w: 102, h: 58 },
    repl: [
      [95, 638],
      [95, 674],
    ],
    replLabel: { x: 103, y: 660, anchor: 'start' },
    redis: { x: 194, y: 560, w: 142, h: 230 },
    redisTitle: 'redis 7',
    redisSub: 'event bus · cache',
    segs: {
      streams: { x: 206, y: 578, w: 118, h: 46 },
      cache: { x: 206, y: 632, w: 118, h: 46 },
      boards: { x: 206, y: 686, w: 118, h: 46 },
    },
    flows: [
      [
        [24, 400],
        [14, 400],
        [14, 542],
        [226, 542],
        [226, 576],
      ],
      [
        [300, 578],
        [300, 552],
        [346, 552],
        [346, 404],
        [338, 404],
      ],
      [
        [250, 578],
        [250, 530],
        [95, 530],
        [95, 498],
      ],
    ],
    chips: [0, 1, 2].map((i) => ({ x: 24, y: 812 + i * 52, w: 312, h: 44 })),
  };
}

/** Orthogonal polyline with softly rounded corners. */
function orth(pts: Pt[], r = 8): string {
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const d1 = Math.hypot(x1 - x0, y1 - y0) || 1;
    const d2 = Math.hypot(x2 - x1, y2 - y1) || 1;
    const rr = Math.min(r, d1 / 2, d2 / 2);
    d += ` L${x1 - ((x1 - x0) / d1) * rr},${y1 - ((y1 - y0) / d1) * rr} Q${x1},${y1} ${x1 + ((x2 - x1) / d2) * rr},${y1 + ((y2 - y1) / d2) * rr}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${last[0]},${last[1]}`;
}

function Label({ box, title, sub, L, dy = 0 }: { box: Box; title: string; sub?: string; L: Layout; dy?: number }) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2 + dy;
  return (
    <>
      <text className="arch-title" x={cx} y={sub ? cy - 2 : cy + L.title * 0.35} textAnchor="middle" fontSize={L.title}>
        {title}
      </text>
      {sub && (
        <text className="arch-sub" x={cx} y={cy + L.sub + 3} textAnchor="middle" fontSize={L.sub}>
          {sub}
        </text>
      )}
    </>
  );
}

function Cylinder({ box, title, sub, L }: { box: Box; title: string; sub: string; L: Layout }) {
  const e = Math.min(9, box.h * 0.16);
  const { x, y, w, h } = box;
  return (
    <g className="arch-cyl">
      <path d={`M${x},${y + e} A${w / 2},${e} 0 0 0 ${x + w},${y + e} V${y + h - e} A${w / 2},${e} 0 0 1 ${x},${y + h - e} Z`} />
      <ellipse cx={x + w / 2} cy={y + e} rx={w / 2} ry={e} />
      <Label box={{ x, y: y + e, w, h: h - e }} title={title} sub={sub} L={L} />
    </g>
  );
}

function Diagram({ L }: { L: Layout }) {
  const uid = useId().replace(/:/g, '');
  const arrow = `${uid}-arrow`;
  const arrowMain = `${uid}-arrow-main`;
  return (
    <svg className="arch-svg" viewBox={`0 0 ${L.w} ${L.h}`} role="img" aria-labelledby={`${uid}-t ${uid}-d`}>
      <title id={`${uid}-t`}>cubetype architecture</title>
      <desc id={`${uid}-d`}>
        The browser talks HTTP and WebSockets to a Google Cloud load balancer (GKE Ingress), which routes to the web frontend and seven microservices
        (auth, scramble, wca, solve, stats, leaderboard, race) running as replicated deployments on GKE. Services store data in PostgreSQL (CloudNativePG
        primary and replica) and Redis. The solve service publishes solve events to a Redis stream, consumed by the stats and leaderboard services.
      </desc>
      <defs>
        <marker id={arrow} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,1 L9,5 L0,9 z" className="arch-head" />
        </marker>
        <marker id={arrowMain} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0,1 L9,5 L0,9 z" className="arch-head-main" />
        </marker>
      </defs>

      {/* cluster boundary */}
      <rect className="arch-cluster" x={L.cluster.x} y={L.cluster.y} width={L.cluster.w} height={L.cluster.h} rx={16} />
      <text className="arch-sub" x={L.cluster.x + 16} y={L.cluster.y + 22} fontSize={L.sub}>
        {L.clusterLabel}
      </text>

      {/* request path */}
      <g className="arch-wire">
        {L.wires.map((p, i) => (
          <path key={i} d={orth(p)} />
        ))}
        {L.arrows.map((p, i) => (
          <path key={i} d={orth(p)} markerEnd={`url(#${arrow})`} />
        ))}
      </g>
      <g className="arch-dot">
        {L.dots.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={2.5} />
        ))}
      </g>
      <text className="arch-sub" x={L.protocol[0]} y={L.protocol[1]} fontSize={L.sub}>
        http · ws
      </text>

      {/* browser */}
      <g className="arch-node">
        <rect x={L.browser.x} y={L.browser.y} width={L.browser.w} height={L.browser.h} rx={10} />
        {[0, 1, 2].map((i) => (
          <circle key={i} className="arch-chrome" cx={L.browser.x + 12 + i * 9} cy={L.browser.y + 11} r={2.6} />
        ))}
        <Label box={{ ...L.browser, y: L.browser.y + 4 }} title="browser" sub="react spa · offline-first" L={L} />
      </g>

      {/* load balancer */}
      <g className="arch-node arch-lb">
        <rect x={L.lb.x} y={L.lb.y} width={L.lb.w} height={L.lb.h} rx={10} />
        <Label box={L.lb} title="cloud load balancer" sub={L.lbSub} L={L} />
      </g>

      {/* services (offset shadow = replicas) */}
      {SERVICES.map((s) => {
        const b = L.services[s.id];
        return (
          <g key={s.id} className="arch-node arch-svc">
            <rect className="arch-replica" x={b.x + 4} y={b.y + 4} width={b.w} height={b.h} rx={10} />
            <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={10} />
            <Label box={b} title={s.id} sub={s.sub} L={L} />
            {s.hpa && (
              <g className="arch-hpa">
                <rect x={b.x + b.w - 30} y={b.y - 7} width={28} height={14} rx={7} />
                <text x={b.x + b.w - 16} y={b.y + 3.5} textAnchor="middle" fontSize={9}>
                  hpa
                </text>
              </g>
            )}
          </g>
        );
      })}

      {/* postgres */}
      <rect className="arch-store" x={L.pg.x} y={L.pg.y} width={L.pg.w} height={L.pg.h} rx={12} />
      <Cylinder box={L.primary} title="primary" sub="read / write" L={L} />
      <Cylinder box={L.replica} title="replica" sub="hot standby" L={L} />
      <g className="arch-wire">
        <path d={orth(L.repl)} markerEnd={`url(#${arrow})`} />
      </g>
      <text className="arch-sub" x={L.replLabel.x} y={L.replLabel.y} textAnchor={L.replLabel.anchor} fontSize={L.sub - 1}>
        replication
      </text>
      <text className="arch-title" x={L.pg.x + L.pg.w / 2} y={L.pg.y + L.pg.h - 36} textAnchor="middle" fontSize={L.title - 1}>
        {L.pgTitle}
      </text>
      <text className="arch-sub" x={L.pg.x + L.pg.w / 2} y={L.pg.y + L.pg.h - 18} textAnchor="middle" fontSize={L.sub}>
        {L.pgSub}
      </text>

      {/* redis */}
      <rect className="arch-store" x={L.redis.x} y={L.redis.y} width={L.redis.w} height={L.redis.h} rx={12} />
      <g className="arch-node arch-stream">
        <rect x={L.segs.streams.x} y={L.segs.streams.y} width={L.segs.streams.w} height={L.segs.streams.h} rx={8} />
        <Label box={L.segs.streams} title="streams" sub="cubetype:events" L={L} />
      </g>
      <g className="arch-node">
        <rect x={L.segs.cache.x} y={L.segs.cache.y} width={L.segs.cache.w} height={L.segs.cache.h} rx={8} />
        <Label box={L.segs.cache} title="cache" sub="wca · rate limits" L={L} />
      </g>
      <g className="arch-node">
        <rect x={L.segs.boards.x} y={L.segs.boards.y} width={L.segs.boards.w} height={L.segs.boards.h} rx={8} />
        <Label box={L.segs.boards} title="leaderboards" sub="sorted sets" L={L} />
      </g>
      <text className="arch-title" x={L.redis.x + L.redis.w / 2} y={L.redis.y + L.redis.h - 36} textAnchor="middle" fontSize={L.title - 1}>
        {L.redisTitle}
      </text>
      <text className="arch-sub" x={L.redis.x + L.redis.w / 2} y={L.redis.y + L.redis.h - 18} textAnchor="middle" fontSize={L.sub}>
        {L.redisSub}
      </text>

      {/* event flow: solve → stream → stats / leaderboard */}
      <g className="arch-flow">
        {L.flows.map((p, i) => (
          <path key={i} d={orth(p, 10)} markerEnd={`url(#${arrowMain})`} />
        ))}
      </g>

      {/* kubernetes notes */}
      {L.chips.map((b, i) => (
        <g key={i} className="arch-chip">
          <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={10} />
          <circle className="arch-chip-dot" cx={b.x + 16} cy={b.y + b.h / 2} r={4} />
          <text className="arch-title" x={b.x + 30} y={b.y + b.h / 2 - 3} fontSize={L.title - 2}>
            {CHIPS[i].t}
          </text>
          <text className="arch-sub" x={b.x + 30} y={b.y + b.h / 2 + 12} fontSize={L.sub - 0.5}>
            {CHIPS[i].s}
          </text>
        </g>
      ))}
    </svg>
  );
}

const WIDE = wideLayout();
const TALL = tallLayout();

/** Picks the wide or the tall layout from the available width (not the viewport). */
export function ArchitectureDiagram() {
  const ref = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = (w: number) => setTall(w < 640);
    update(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => update(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className={`arch${tall ? ' tall' : ''}`}>
      <Diagram L={tall ? TALL : WIDE} />
    </div>
  );
}
