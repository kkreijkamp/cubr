import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getEvent, type Penalty, type Precision } from '@cubetype/cubestats';
import { TimerDisplay } from '../../../timer/TimerDisplay';
import { alertAt, beep, type TimerState } from '../../../timer/useTimerEngine';
import type { Settings, TimerUpdate } from '../../../lib/settings';
import { bluetoothAvailable } from '../../../input/bluetooth/device';
import { cubeGroup } from '../../../input/bluetooth/cubes';
import type { CubeCtx } from '../../../input/bluetooth/cubes/context';
import { CubeView } from '../../../input/bluetooth/cubeView';
import { cubeKey, SmartCubeSession, type ScrambleHint, type SmartEvent, type SmartPuzzle, type SmartSolve } from '../../../input/bluetooth/smartSession';
import { movesBetween, scrambleFor, warmSolver } from '../../../input/cube/solverClient';
import { SOLVED_FACELET } from '../../../input/cube/cubie';
import { inputStore, updateInput } from '../../../input/inputMode';
import { puzzlePalette } from '../../../input/virtual/palette';
import { drawPoly, type Camera, type Palette } from '../../../input/virtual/render3d';
import { cubeFacelet, drawQCube } from '../../../input/virtual/renderFlat';
import { noFocus } from '../ConfigBar';
import { useMacAddress } from './macPrompt';
import { baseCamera } from './VirtualInput';

interface Props {
  event: string;
  scramble: string | null;
  /** keys are taken (off while a dialog, menu or the command line is open) */
  enabled: boolean;
  inspection: boolean;
  alerts: 'off' | 'beep' | 'voice';
  last: { timeMs: number; penalty: Penalty } | null;
  precision: Precision;
  timerUpdate: TimerUpdate;
  sizeRem: number;
  pb: boolean;
  settings: Pick<Settings, 'stickerColours' | 'customStickers' | 'virtualSpeed' | 'virtualView' | 'virtualFloat' | 'smartScrambled' | 'smartSpace' | 'smartBeep' | 'smartView' | 'smartTurnMark' | 'smartReset'>;
  onState: (s: TimerState) => void;
  /** a solve; `scramble`: the one worked out from a cube scrambled by hand */
  onSolve: (r: { timeMs: number; penalty: Penalty }, scramble?: string) => void;
  /** the cube was scrambled by hand: a scramble that gives its state */
  onScramble: (text: string) => void;
  /** the cube's progress along the scramble, for the scramble line */
  onHint: (h: ScrambleHint | null) => void;
}

type Conn = { status: 'off' } | { status: 'connecting' } | { status: 'connected'; name: string } | { status: 'reconnecting'; name: string } | { status: 'error'; message: string };

const STEP = Math.PI / 24;

function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

/** the smart cube puzzle an event is solved on, if any */
function eventPuzzle(event: string): SmartPuzzle | null {
  const p = getEvent(event)?.puzzle;
  return p === '3x3x3' ? '333' : p === '2x2x2' ? '222' : null;
}

const smooth = (t: number) => {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
};

/**
 * A bluetooth smart cube (csTimer's "bluetooth cube" input): GAN, Giiker, GoCube, MoYu and QiYi
 * cubes. Scramble it (the scramble line follows along), and the timer starts with the first turn
 * and stops when it's solved.
 */
export function SmartCubeInput(p: Props) {
  const { group, battery } = useMemo(cubeGroup, []);
  const session = useMemo(() => new SmartCubeSession(), []);
  const [conn, setConn] = useState<Conn>({ status: 'off' });
  const [available, setAvailable] = useState<boolean | null>(null);
  const [bat, setBat] = useState<number | null>(null);
  const [puzzle, setPuzzle] = useState<SmartPuzzle>('333');
  const [askReset, setAskReset] = useState(false);
  const [tick, setTick] = useState(0);
  const props = useRef(p);
  props.current = p;
  const { mac, element: macPrompt } = useMacAddress();
  const device = useRef<string | null>(null);
  const markTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alertTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const reconnect = useRef<ReturnType<typeof setTimeout> | null>(null);
  const view = useRef<CubeView>(new CubeView(3));
  const dirty = useRef(true);
  const fixAsked = useRef(false);
  /** counts the times the cube was marked scrambled */
  const attempts = useRef(0);
  /** the scramble being worked out for a cube scrambled by hand, saved with its solve */
  const ownScramble = useRef<Promise<string | null> | null>(null);
  const lastHint = useRef<string>('null');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const cam = useRef<Camera | null>(null);

  session.inspection = p.inspection;
  session.mark = p.settings.smartScrambled;
  session.turnMark = p.settings.smartTurnMark;
  view.current.speed = p.settings.virtualSpeed;

  useEffect(() => {
    void bluetoothAvailable().then(setAvailable);
    warmSolver();
  }, []);

  const clearAlerts = () => {
    alertTimers.current.forEach(clearTimeout);
    alertTimers.current = [];
  };
  const clearMark = () => {
    if (markTimer.current) clearTimeout(markTimer.current);
    markTimer.current = null;
  };

  /** the scramble line: how far along the scramble the cube is (only for the cube's own puzzle, before the solve starts) */
  const refreshHint = useCallback(() => {
    const corners = session.puzzle === '222';
    let hint: ScrambleHint | null = null;
    if (group.connected && session.phase !== 'running' && eventPuzzle(props.current.event) === session.puzzle) {
      const r = session.hinter.check(session.cube, corners);
      hint = r.hint;
      if (r.needFix && !fixAsked.current && session.hinter.target) {
        // off the scramble: work out the way back onto it
        fixAsked.current = true;
        const from = session.cube.clone();
        const to = session.hinter.target;
        session.hinter.asked = from;
        void movesBetween(from.toFaceCube(), to.toFaceCube(), corners).then((moves) => {
          fixAsked.current = false;
          if (moves !== null && session.hinter.target === to) session.hinter.setFix(from, moves);
          refreshHint();
        });
      }
    }
    const key = JSON.stringify(hint);
    if (key !== lastHint.current) {
      lastHint.current = key;
      props.current.onHint(hint);
    }
  }, [session, group]);

  const markScrambled = useCallback(
    (now: number) => {
      clearMark();
      if (!session.markScrambled(now)) return;
      const p = props.current;
      // scrambled by hand: the scramble saved with the solve is one that gives this state
      const attempt = ++attempts.current;
      ownScramble.current = null;
      if (!session.matchesScramble() && session.puzzle === '333' && eventPuzzle(p.event) === '333') {
        const found = scrambleFor(session.facelet);
        ownScramble.current = found;
        void found.then((text) => {
          // the scramble line too, while this attempt lasts (not once the next scramble is up)
          if (text && attempt === attempts.current && session.phase !== 'idle') props.current.onScramble(text);
        });
      }
      if (p.settings.smartBeep) beep(880);
      if (session.inspection && p.alerts !== 'off') {
        const mode = p.alerts;
        alertTimers.current = [setTimeout(() => alertAt(8, mode), 8000), setTimeout(() => alertAt(12, mode), 12000)];
      }
      setTick((t) => t + 1);
    },
    [session],
  );

  /** a solve (or a DNF) to save, with the scramble worked out from the cube if it was scrambled by hand */
  const finish = useCallback((r: SmartSolve) => {
    const own = ownScramble.current;
    ownScramble.current = null;
    if (!own) props.current.onSolve(r);
    else void own.then((text) => props.current.onSolve(r, text ?? undefined));
  }, []);

  const handle = useCallback(
    (ev: SmartEvent) => {
      if (ev.started) clearAlerts();
      if (ev.solved) {
        clearAlerts();
        finish(ev.solved);
      }
      if (ev.markIn !== undefined) {
        const at = session.lastTime;
        if (ev.markIn === 0) markScrambled(at);
        else markTimer.current = setTimeout(() => markScrambled(at), ev.markIn);
      }
    },
    [session, markScrambled, finish],
  );

  /** the cube as it is now counts as solved (csTimer's "reset (mark solved)"), remembered for this cube */
  const markSolved = useCallback(() => {
    clearMark();
    const { reading, event } = session.markSolved(performance.now());
    if (device.current) updateInput({ smartSolved: { ...inputStore.get().smartSolved, [device.current]: reading } });
    view.current.reset(session.facelet);
    dirty.current = true;
    setAskReset(false);
    handle(event);
    refreshHint();
    setTick((t) => t + 1);
  }, [session, handle, refreshHint]);

  const ctx: CubeCtx = useMemo(
    () => ({
      state(facelet, prevMoves, ts, name, pz = '333') {
        clearMark();
        const key = cubeKey(name);
        if (key !== device.current) {
          // a cube's solved reading is kept per cube
          device.current = key;
          session.setSolvedReading(inputStore.get().smartSolved[key] ?? null);
        }
        const ev = session.state(facelet, prevMoves, ts, pz, performance.now());
        const v = view.current;
        if (v.n !== (pz === '222' ? 2 : 3)) {
          view.current = new CubeView(pz === '222' ? 2 : 3);
          view.current.speed = props.current.settings.virtualSpeed;
          view.current.reset(session.facelet);
          setPuzzle(pz);
        } else v.update(session.facelet, prevMoves);
        dirty.current = true;
        handle(ev);
        refreshHint();
        setTick((t) => t + 1);
      },
      battery: (level) => setBat(level),
      mac: (name, found, suggested, opts) => mac(name, found, suggested, opts),
      connected(facelet) {
        const name = device.current;
        if (!name || facelet === (inputStore.get().smartSolved[name] ?? SOLVED_FACELET)) return;
        const rst = props.current.settings.smartReset;
        if (rst === 'always') markSolved();
        else if (rst === 'ask') setAskReset(true);
      },
      log: () => undefined,
      lost: () => void group.disconnect(true).then(() => group.onDisconnect?.()),
    }),
    [session, mac, handle, refreshHint, markSolved, group],
  );

  const afterConnect = useCallback(
    (name: string) => {
      setConn({ status: 'connected', name });
      view.current.reset(session.facelet);
      dirty.current = true;
      void battery().then((b) => b !== null && setBat(b));
      refreshHint();
    },
    [session, battery, refreshHint],
  );

  const connect = useCallback(async () => {
    if (reconnect.current) clearTimeout(reconnect.current);
    setConn({ status: 'connecting' });
    try {
      afterConnect(await group.connect(ctx));
    } catch (e) {
      const msg = (e as Error).name === 'NotFoundError' ? 'no cube chosen' : (e as Error).message || "couldn't connect";
      setConn({ status: 'error', message: msg });
    }
  }, [group, ctx, afterConnect]);

  // the cube went to sleep or out of range: try again every few seconds, no click needed
  useEffect(() => {
    group.onDisconnect = () => {
      const dev = group.lastDevice;
      setConn({ status: 'reconnecting', name: dev?.name ?? 'cube' });
      setAskReset(false);
      refreshHint();
      const retry = () => {
        if (!dev) return;
        group.setUp(dev, ctx).then(afterConnect, () => {
          reconnect.current = setTimeout(retry, 2500);
        });
      };
      reconnect.current = setTimeout(retry, 2500);
    };
    return () => {
      group.onDisconnect = null;
      if (reconnect.current) clearTimeout(reconnect.current);
      clearMark();
      clearAlerts();
      void group.disconnect(false);
    };
  }, [group, ctx, afterConnect, refreshHint]);

  // battery: csTimer asks every minute
  useEffect(() => {
    if (conn.status !== 'connected') return;
    const id = setInterval(() => void battery().then((b) => b !== null && setBat(b)), 60_000);
    return () => clearInterval(id);
  }, [conn.status, battery]);

  // a new scramble (or event): follow the cube along it
  const eventPz = eventPuzzle(p.event);
  useEffect(() => {
    session.hinter.setScramble(eventPz ? p.scramble : null);
    fixAsked.current = false;
    refreshHint();
  }, [session, p.scramble, eventPz, refreshHint]);
  useEffect(() => () => props.current.onHint(null), []);

  // space: scrambled (or, not connected yet, connect); esc gives up; arrows turn the view
  useEffect(() => {
    if (!p.enabled) return;
    const down = (e: KeyboardEvent) => {
      if (isTyping(e.target) || document.querySelector('.modal-backdrop') || e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat && group.connected && session.phase === 'idle' && props.current.settings.smartSpace) markScrambled(performance.now());
      } else if (e.key === 'Escape') {
        clearMark();
        if (session.phase === 'idle') return;
        e.preventDefault();
        e.stopPropagation();
        clearAlerts();
        const r = session.escape();
        if (r) finish(r);
        else ownScramble.current = null;
        refreshHint();
        setTick((t) => t + 1);
      } else if (e.key.startsWith('Arrow') && cam.current) {
        e.preventDefault();
        const c = cam.current;
        if (e.key === 'ArrowLeft') c.yaw = Math.max(-Math.PI / 3, c.yaw - STEP);
        if (e.key === 'ArrowRight') c.yaw = Math.min(Math.PI / 3, c.yaw + STEP);
        if (e.key === 'ArrowUp') c.pitch = Math.min(1.35, c.pitch + STEP);
        if (e.key === 'ArrowDown') c.pitch = Math.max(-1.35, c.pitch - STEP);
        dirty.current = true;
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || isTyping(e.target) || document.querySelector('.modal-backdrop')) return;
      e.preventDefault();
      if (!group.connected && (conn.status === 'off' || conn.status === 'error')) void connect();
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
    };
  }, [p.enabled, session, group, connect, conn.status, markScrambled, refreshHint, finish]);

  // what the timer shows, by value (the page hands over a fresh `last` object on every render)
  const lastMs = p.last?.timeMs;
  const lastPenalty = p.last?.penalty;
  const state: TimerState = useMemo(() => {
    void tick;
    const result = lastMs !== undefined && lastPenalty !== undefined ? { timeMs: lastMs, penalty: lastPenalty } : null;
    if (session.phase === 'running') return { phase: 'running', inInspection: false, startedAt: session.startTime, inspectionStartedAt: null, result: null };
    if (session.phase === 'scrambled') {
      if (session.inspection) return { phase: 'inspecting', inInspection: true, startedAt: null, inspectionStartedAt: session.startTime, result: null };
      return { phase: 'ready', inInspection: false, startedAt: null, inspectionStartedAt: null, result: null };
    }
    return { phase: 'idle', inInspection: false, startedAt: null, inspectionStartedAt: null, result };
  }, [tick, session, lastMs, lastPenalty]);
  const { onState } = p;
  useEffect(() => onState(state), [state, onState]);

  // the cube on screen
  const shown = p.settings.smartView !== 'off' && conn.status === 'connected';
  const flat = p.settings.smartView === '2D';
  const palette = useMemo<Palette>(() => puzzlePalette('cube', p.settings), [p.settings]);
  useEffect(() => {
    cam.current = baseCamera(view.current.model, p.settings.virtualView);
    dirty.current = true;
  }, [p.settings.virtualView, puzzle]);

  useEffect(() => {
    if (!shown) return;
    const canvas = canvasRef.current;
    const box = boxRef.current;
    if (!canvas || !box) return;
    let raf = 0;
    let last = performance.now();
    let size = { w: 0, h: 0 };
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
      const v = view.current;
      const moving = !flat && v.step(dt);
      if (moving || dirty.current) {
        dirty.current = false;
        const ctx = canvas.getContext('2d')!;
        ctx.clearRect(0, 0, size.w, size.h);
        paint(ctx, size.w, size.h, v, flat, cam.current ?? baseCamera(v.model, 'UF'), palette, props.current.settings.virtualFloat / 100);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [shown, flat, palette]);

  const idle = state.phase === 'idle';
  const giveUp = () => {
    clearAlerts();
    const r = session.escape();
    if (r) finish(r);
    else ownScramble.current = null;
    refreshHint();
    setTick((t) => t + 1);
  };
  const disconnect = () => void group.disconnect(false).then(() => setConn({ status: 'off' }));

  // the status in rows: the cube, what can be done, then a question or a word on what to do
  const rows: React.ReactNode[] = [];
  if (available === false) rows.push(<span className="error">this browser has no bluetooth - use Chrome or Edge on a computer or Android, with bluetooth on</span>);
  else if (conn.status === 'off')
    rows.push(
      <button className="btn-text active" onClick={() => void connect()} {...noFocus}>
        connect a bluetooth cube
      </button>,
    );
  else if (conn.status === 'connecting') rows.push(<span className="sub">connecting...</span>);
  else if (conn.status === 'reconnecting') rows.push(<span className="sub">{conn.name} disconnected - turn it to wake it up</span>);
  else if (conn.status === 'error')
    rows.push(
      <>
        <span className="error">{conn.message}</span>
        <button className="btn-text" onClick={() => void connect()} {...noFocus}>
          try again
        </button>
      </>,
    );
  else {
    const eventName = getEvent(p.event)?.name ?? p.event;
    rows.push(
      <span className="sub">
        {conn.name}
        {bat !== null && ` - ${bat}%`}
      </span>,
    );
    rows.push(
      idle ? (
        <>
          <button className="btn-text" onClick={markSolved} data-tip="the cube as it is now is solved" {...noFocus}>
            mark solved
          </button>
          <button className="btn-text" onClick={disconnect} {...noFocus}>
            disconnect
          </button>
        </>
      ) : (
        <button className="btn-text" onClick={giveUp} {...noFocus}>
          <kbd>esc</kbd> {state.phase === 'running' ? 'give up' : 'cancel'}
        </button>
      ),
    );
    if (askReset)
      rows.push(
        <>
          <span className="sub">it reads as unsolved - is it solved?</span>
          <button className="btn-text active" onClick={markSolved} {...noFocus}>
            yes
          </button>
          <button className="btn-text" onClick={() => setAskReset(false)} {...noFocus}>
            no
          </button>
        </>,
      );
    else if (eventPz === null) rows.push(<span className="sub">the scramble can't be checked for {eventName}</span>);
    else if (eventPz !== puzzle) rows.push(<span className="sub">this is a {puzzle === '222' ? '2x2' : '3x3'} - the scramble can't be checked for {eventName}</span>);
    else if (idle && (session.mark !== 'never' || p.settings.smartSpace))
      rows.push(
        <span className="sub">
          {session.mark === 'scramble' ? 'scramble it to start' : session.mark === 'never' ? '' : `scramble it, then wait ${session.mark} s`}
          {p.settings.smartSpace && (
            <>
              {session.mark === 'never' ? 'press ' : ' or press '}
              <kbd>space</kbd>
            </>
          )}
        </span>,
      );
  }
  const bar = (
    <div className={shown ? 'tp-virtual-bar' : 'tp-hardware-bar'}>
      {rows.map((r, i) => (
        <span className="tp-smart-row" key={i}>
          {r}
        </span>
      ))}
    </div>
  );

  if (!shown) {
    return (
      <div className="tp-hardware">
        <TimerDisplay state={state} precision={p.precision} timerUpdate={p.timerUpdate} sizeRem={p.sizeRem} pb={p.pb && idle} />
        {bar}
        {macPrompt}
      </div>
    );
  }
  return (
    <div className={`tp-virtual${flat ? ' flat' : ''}`}>
      <TimerDisplay state={state} precision={p.precision} timerUpdate={p.timerUpdate} sizeRem={Math.max(3, p.sizeRem * 0.6)} pb={p.pb && idle} />
      <div className="tp-virtual-canvas" ref={boxRef}>
        <canvas ref={canvasRef} aria-label="the smart cube" role="img" />
      </div>
      <div className="tp-virtual-side">{bar}</div>
      {macPrompt}
    </div>
  );
}

function paint(ctx: CanvasRenderingContext2D, w: number, h: number, v: CubeView, flat: boolean, cam: Camera, palette: Palette, float: number) {
  const puzzle = v.model.twisty.puzzle;
  if (flat) {
    const colors: string[] = [];
    puzzle.slots.forEach((s, slot) => (colors[cubeFacelet(v.n, s.center, s.normal)] = palette.faces[puzzle.slots[v.target[slot]].face] ?? palette.body));
    drawQCube(ctx, w, h, v.n, colors);
    return;
  }
  const turning = v.active.map((a) => {
    const mv = v.model.canonical(a.move);
    return { move: mv, angle: puzzle.angle(mv) * smooth(a.progress) };
  });
  drawPoly(ctx, w, h, puzzle, v.shown, cam, palette, turning, { float });
}
