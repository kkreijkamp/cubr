import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getEvent, type Penalty, type Precision } from '@cubetype/cubestats';
import { TimerDisplay } from '../../../timer/TimerDisplay';
import { alertAt, type TimerState } from '../../../timer/useTimerEngine';
import type { Settings, TimerUpdate } from '../../../lib/settings';
import { modelFor, type VirtualModel } from '../../../input/virtual/models';
import { clockColors, puzzlePalette } from '../../../input/virtual/palette';
import { drawPoly, drawSq1, type Camera, type Palette } from '../../../input/virtual/render3d';
import { cubeFacelet, drawNet, drawQCube, drawSq1Flat, type NetLayout } from '../../../input/virtual/renderFlat';
import { drawClock } from '../../../input/virtual/renderClock';
import { VirtualSession, type VirtualResult } from '../../../input/virtual/session';
import type { Move } from '../../../input/virtual/polyPuzzle';
import type { Sq1Move, Sq1State } from '../../../input/virtual/square1';
import type { ClockState } from '../../../input/virtual/clock';
import { isTouchDevice } from '../feedback';
import { noFocus } from '../ConfigBar';

interface Props {
  event: string;
  /** qCube: drawn flat, moves without animation */
  flat: boolean;
  scramble: string | null;
  /** keys are taken (off while a dialog, menu or the command line is open) */
  enabled: boolean;
  inspection: boolean;
  alerts: 'off' | 'beep' | 'voice';
  /** the latest solve, shown while idle */
  last: { timeMs: number; penalty: Penalty } | null;
  precision: Precision;
  timerUpdate: TimerUpdate;
  sizeRem: number;
  pb: boolean;
  settings: Pick<Settings, 'stickerColours' | 'customStickers' | 'virtualSpeed' | 'virtualView'>;
  onState: (s: TimerState) => void;
  onSolve: (r: { timeMs: number; penalty: Penalty }) => void;
}

const STEP = Math.PI / 24;

function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

const MOVE_KEYS = /^(Key[A-Z]|Digit\d|Semicolon|Comma|Period|Slash)$/;

/** the camera a puzzle starts with (cubes: csTimer's orientation option) */
function baseCamera(model: VirtualModel, view: 'UF' | 'URF'): Camera {
  if (model.kind === 'poly') {
    const v = model.twisty.view;
    const cube = model.twisty.id.startsWith('cube');
    return {
      yaw: cube && view === 'URF' ? Math.PI / 6 : v.yaw,
      pitch: cube && view === 'URF' ? (5 * Math.PI) / 24 : model.twisty.id === 'pyraminx' ? 1.1 : v.pitch,
      distance: 4.2,
      radius: v.radius,
    };
  }
  return { yaw: -Math.PI / 12, pitch: 0.55, distance: 4.2, radius: 3.3 };
}

/** the nets qCube draws for puzzles other than cubes */
function netFor(model: VirtualModel): NetLayout | null {
  if (model.kind !== 'poly') return null;
  const ax = (n: string) => model.twisty.puzzle.axisIndex(n);
  switch (model.twisty.id) {
    case 'megaminx':
      // csTimer's qCube megaminx: the top face and the five around it
      return { pieces: [{ root: ax('U'), tree: ['F', 'R', 'BR', 'BL', 'L'].map((f) => [ax('U'), ax(f)] as [number, number]), up: [0, 0, -1] }] };
    case 'pyraminx':
      return { pieces: [{ root: 0, tree: [[0, 1], [0, 2], [0, 3]], up: [0, 1, 0] }] };
    case 'skewb':
      // faces U R F D L B: a cross round the front, the back beside the right
      return { pieces: [{ root: 2, tree: [[2, 0], [2, 3], [2, 4], [2, 1], [1, 5]], up: [0, 1, 0] }] };
    default:
      return null;
  }
}

/** the keys the puzzle answers to, for the legend: key -> move name */
function legend(model: VirtualModel): [string, string][] {
  const codes = [...'IKJFHGDESLWO'].map((c) => `Key${c}`).concat(['Semicolon', 'KeyA'], [...'TYNBPQURMVXZC'].map((c) => `Key${c}`), ['Comma', 'Period', 'Slash'], [...'1234567890'].map((d) => `Digit${d}`));
  const out: [string, string][] = [];
  const m = model as unknown as { key(c: string): { move: unknown } | { depth: true } | null; name(mv: unknown): string };
  for (const code of codes) {
    const r = m.key(code);
    const label = code.replace(/^Key|^Digit/, '').replace('Semicolon', ';').replace('Comma', ',').replace('Period', '.').replace('Slash', '/').toLowerCase();
    if (r && 'move' in r) out.push([label, m.name(r.move)]);
    else if (r) out.push([label, 'depth']);
  }
  return out;
}

export function VirtualInput(p: Props) {
  const model = useMemo(() => modelFor(p.event), [p.event]);
  const blind = Boolean(getEvent(p.event)?.blind);
  const speed = p.flat ? 0 : p.settings.virtualSpeed;
  const session = useMemo(() => (model ? new VirtualSession(model, { speed, blind, inspection: p.inspection }) : null), [model]); // eslint-disable-line react-hooks/exhaustive-deps
  const [phase, setPhase] = useState(session?.phase ?? 'idle');
  const [info, setInfo] = useState<{ moves: number; timeMs: number } | null>(null);
  const [showKeys, setShowKeys] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const cam = useRef<Camera | null>(null);
  const alertTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const touch = useMemo(isTouchDevice, []);
  const props = useRef(p);
  props.current = p;
  const dirty = useRef(true);

  // keep the session's options current
  useEffect(() => {
    if (!session) return;
    session.speed = speed;
    session.blind = blind;
    session.inspection = p.inspection;
  }, [session, speed, blind, p.inspection]);

  useEffect(() => {
    if (model) cam.current = baseCamera(model, p.settings.virtualView);
    dirty.current = true;
  }, [model, p.settings.virtualView]);

  // the timer display follows the session
  const publish = useCallback(() => {
    if (!session) return;
    setPhase(session.phase);
    setError(session.error);
    dirty.current = true;
  }, [session]);
  useEffect(() => (session ? session.subscribe(publish) : undefined), [session, publish]);

  const clearAlerts = () => {
    alertTimers.current.forEach(clearTimeout);
    alertTimers.current = [];
  };
  useEffect(() => clearAlerts, []);

  const finish = useCallback((r: VirtualResult) => {
    clearAlerts();
    setInfo({ moves: r.moves, timeMs: r.timeMs });
    props.current.onSolve({ timeMs: r.timeMs, penalty: r.penalty });
  }, []);

  const start = useCallback(
    (now: number) => {
      const scr = props.current.scramble;
      if (!session || !scr || session.phase !== 'idle') return;
      setInfo(null);
      // inspection: the judge's 8 and 12 second calls
      if (session.scramble(scr, now) && session.inspectionStartedAt !== null && props.current.alerts !== 'off') {
        const mode = props.current.alerts;
        alertTimers.current = [setTimeout(() => alertAt(8, mode), 8000), setTimeout(() => alertAt(12, mode), 12000)];
      }
    },
    [session],
  );

  const giveUp = useCallback(
    (now: number) => {
      if (!session) return;
      clearAlerts();
      const r = session.escape(now);
      if (r) finish(r);
    },
    [session, finish],
  );

  const doMove = useCallback(
    (mv: unknown, now: number) => {
      if (!session) return;
      const wasRunning = session.phase === 'running';
      const r = session.move(mv, now);
      if (!wasRunning && session.phase === 'running') clearAlerts();
      if (r.solved) finish(r.solved);
    },
    [session, finish],
  );

  // keyboard: csTimer's layout while scrambled or solving; space scrambles; esc gives up; arrows turn the view
  useEffect(() => {
    if (!session || !p.enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || document.querySelector('.modal-backdrop')) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const now = e.timeStamp > 0 ? e.timeStamp : performance.now();
      if (e.code === 'Space') {
        e.preventDefault();
        if (e.repeat) return;
        if (session.phase === 'idle') start(now);
        else if (session.model.kind === 'poly') {
          session.model.twisty.resetDepth();
          dirty.current = true;
        }
        return;
      }
      if (e.key === 'Escape') {
        if (session.phase === 'idle') return;
        e.preventDefault();
        e.stopPropagation();
        giveUp(now);
        return;
      }
      if (e.key.startsWith('Arrow') && cam.current && !props.current.flat) {
        e.preventDefault();
        const c = cam.current;
        if (e.key === 'ArrowLeft') c.yaw = Math.max(-Math.PI / 3, c.yaw - STEP);
        if (e.key === 'ArrowRight') c.yaw = Math.min(Math.PI / 3, c.yaw + STEP);
        if (e.key === 'ArrowUp') c.pitch = Math.min(1.35, c.pitch + STEP);
        if (e.key === 'ArrowDown') c.pitch = Math.max(-1.35, c.pitch - STEP);
        dirty.current = true;
        return;
      }
      if (!MOVE_KEYS.test(e.code) || session.phase === 'idle' || e.repeat) return;
      const r = session.key(e.code, now);
      if (!r.used) return;
      e.preventDefault();
      if (r.solved) finish(r.solved);
      dirty.current = true;
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [session, p.enabled, start, giveUp, finish]);

  // a dialog opening mid-solve doesn't stop it, but leaving the page does
  useEffect(() => () => session?.reset(), [session]);

  // tell the timer page what the timer is doing (focus mode, shortcuts)
  // by value: the page hands over a fresh `last` object on every render
  const lastMs = p.last?.timeMs;
  const lastPenalty = p.last?.penalty;
  const state: TimerState = useMemo(() => {
    const s = session;
    const result = lastMs !== undefined && lastPenalty !== undefined ? { timeMs: lastMs, penalty: lastPenalty } : null;
    if (!s || phase === 'idle') return { phase: 'idle', inInspection: false, startedAt: null, inspectionStartedAt: null, result };
    if (phase === 'inspecting') return { phase: 'inspecting', inInspection: true, startedAt: null, inspectionStartedAt: s.inspectionStartedAt, result: null };
    if (phase === 'ready') return { phase: 'ready', inInspection: false, startedAt: null, inspectionStartedAt: null, result: null };
    return { phase: 'running', inInspection: false, startedAt: s.startedAt, inspectionStartedAt: null, result: null };
  }, [session, phase, lastMs, lastPenalty]);
  const { onState } = p;
  useEffect(() => onState(state), [state, onState]);

  // drawing: one frame loop, redrawing only when something changed or a move is turning
  const palette = useMemo<Palette | null>(() => {
    if (!model) return null;
    const scheme = model.kind === 'sq1' ? 'square1' : model.kind === 'clock' ? 'cube' : model.twisty.scheme;
    return puzzlePalette(scheme, p.settings);
  }, [model, p.settings]);

  useEffect(() => {
    if (!session || !palette) return;
    const canvas = canvasRef.current;
    const box = boxRef.current;
    if (!canvas || !box) return;
    let raf = 0;
    let last = performance.now();
    let size = { w: 0, h: 0 };
    const facelets = new Map<number, number[]>();
    const clockDials: number[] = (session.shown as ClockState).dials?.slice() ?? [];
    const resize = () => {
      const r = box.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      size = { w: Math.max(1, Math.round(r.width)), h: Math.max(1, Math.round(r.height)) };
      canvas.width = size.w * dpr;
      canvas.height = size.h * dpr;
      canvas.style.width = `${size.w}px`;
      canvas.style.height = `${size.h}px`;
      canvas.getContext('2d')!.setTransform(dpr, 0, 0, dpr, 0, 0);
      dirty.current = true;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(box);
    resize();
    const frame = (t: number) => {
      const dt = Math.min(100, t - last);
      last = t;
      const moving = session.step(dt);
      let clockMoving = false;
      if (session.model.kind === 'clock') {
        const target = (session.target as ClockState).dials;
        for (let i = 0; i < 18; i++) {
          // the shortest way round to the dial's new reading
          let d = target[i] - clockDials[i];
          d = ((((d + 6) % 12) + 12) % 12) - 6;
          if (Math.abs(d) > 1e-3) {
            clockDials[i] += speed <= 0 ? d : Math.sign(d) * Math.min(Math.abs(d), (dt / Math.max(speed, 1)) * 1.2 + Math.abs(d) * 0.15);
            clockMoving = true;
          } else clockDials[i] = target[i];
        }
      }
      if (moving || clockMoving || dirty.current) {
        dirty.current = false;
        const ctx = canvas.getContext('2d')!;
        ctx.clearRect(0, 0, size.w, size.h);
        paint(ctx, size.w, size.h, session, props.current.flat, cam.current!, palette, facelets, clockDials);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [session, palette, speed]);

  // touch: csTimer's swipe from one cell of a 3x3 grid to another
  const gesture = useRef<number | null>(null);
  const touchMoves = useMemo(() => (model?.kind === 'poly' ? model.twisty.touch() : {}), [model, phase]); // eslint-disable-line react-hooks/exhaustive-deps
  const cellAt = (e: React.PointerEvent) => {
    const r = boxRef.current!.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * 3);
    const y = Math.floor(((e.clientY - r.top) / r.height) * 3);
    return x < 0 || y < 0 || x > 2 || y > 2 ? null : y * 3 + x + 1;
  };

  if (!model || !session) {
    return <div className="tp-input-note">there is no virtual puzzle for {getEvent(p.event)?.name ?? p.event}</div>;
  }

  const keys = legend(model);
  const idle = phase === 'idle';
  return (
    <div className={`tp-virtual${p.flat ? ' flat' : ''}`}>
      <TimerDisplay state={state} precision={p.precision} timerUpdate={p.timerUpdate} sizeRem={Math.max(3, p.sizeRem * 0.6)} pb={p.pb && idle} />
      <div
        className="tp-virtual-canvas"
        ref={boxRef}
        onPointerDown={(e) => {
          if (e.pointerType === 'mouse' && !touch) return;
          gesture.current = cellAt(e);
        }}
        onPointerUp={(e) => {
          const from = gesture.current;
          gesture.current = null;
          const to = cellAt(e);
          if (from === null || to === null || from === to) return;
          const mv = (touchMoves as Record<string, Move>)[`${from}${to}`];
          if (mv) doMove(mv, e.timeStamp || performance.now());
        }}
      >
        <canvas ref={canvasRef} aria-label={`virtual ${getEvent(p.event)?.name ?? 'puzzle'}`} role="img" />
      </div>
      <div className="tp-virtual-side">
      <div className="tp-virtual-bar">
        {error ? (
          <span className="error">{error}</span>
        ) : idle ? (
          <>
            {info && info.moves > 0 && (
              <span className="sub">
                {info.moves} moves - {((info.moves * 1000) / info.timeMs).toFixed(2)} tps
              </span>
            )}
            <button className="btn-text" onClick={() => start(performance.now())} disabled={!p.scramble} {...noFocus}>
              <kbd>space</kbd> scramble
            </button>
          </>
        ) : (
          <button className="btn-text" onClick={() => giveUp(performance.now())} {...noFocus}>
            <kbd>esc</kbd> {phase === 'running' ? 'give up' : 'cancel'}
          </button>
        )}
        <button className={`btn-text${showKeys ? ' active' : ''}`} onClick={() => setShowKeys((v) => !v)} aria-expanded={showKeys} {...noFocus}>
          keys
        </button>
      </div>
      {showKeys && (
        <div className="tp-virtual-keys" role="note" aria-label="keys">
          {keys.map(([k, name]) => (
            <span key={k}>
              <kbd>{k}</kbd> {name}
            </span>
          ))}
          {!p.flat && (
            <span>
              <kbd>arrows</kbd> view
            </span>
          )}
        </div>
      )}
      </div>
    </div>
  );
}

function paint(ctx: CanvasRenderingContext2D, w: number, h: number, session: VirtualSession, flat: boolean, cam: Camera, palette: Palette, facelets: Map<number, number[]>, clockDials: number[]) {
  const model = session.model;
  const hidden = session.hidden;
  if (model.kind === 'clock') {
    drawClock(ctx, w, h, session.target as ClockState, clockDials, clockColors(), palette);
    return;
  }
  if (model.kind === 'sq1') {
    const state = session.shown as Sq1State;
    const pal = hidden ? { ...palette, faces: palette.faces.map(() => palette.hidden!) } : palette;
    if (flat) drawSq1Flat(ctx, w, h, session.target as Sq1State, pal);
    else drawSq1(ctx, w, h, state, cam, pal, session.active[0] ? { move: session.active[0].move as Sq1Move, progress: smooth(session.active[0].progress) } : null);
    return;
  }
  const puzzle = model.twisty.puzzle;
  if (flat) {
    const state = session.target as Int16Array;
    const colorOf = (slot: number) => (hidden ? palette.hidden! : (palette.faces[puzzle.slots[state[slot]].face] ?? palette.body));
    if (model.twisty.id.startsWith('cube')) {
      const n = Number(model.twisty.id.slice(4));
      let map = facelets.get(n);
      if (!map) {
        map = puzzle.slots.map((s) => cubeFacelet(n, s.center, s.normal));
        facelets.set(n, map);
      }
      const colors: string[] = [];
      map.forEach((f, slot) => (colors[f] = colorOf(slot)));
      drawQCube(ctx, w, h, n, colors);
    } else {
      const layout = netFor(model);
      if (layout) drawNet(ctx, w, h, puzzle, layout, colorOf, palette);
    }
    return;
  }
  const state = session.shown as Int16Array;
  const turning = session.active.map((a) => {
    const mv = model.canonical(a.move as Move);
    return { move: mv, angle: puzzle.angle(mv) * smooth(a.progress) };
  });
  drawPoly(ctx, w, h, puzzle, state, cam, palette, turning, hidden ? () => palette.hidden! : undefined);
}

/** ease in and out */
const smooth = (t: number) => {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
};
