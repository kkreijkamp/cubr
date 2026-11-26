// The virtual clock, drawn flat: the side facing you large on the left, the other side smaller on the
// right (as you would see it after turning the clock over), pins between the dials.
import type { ClockState } from './clock';
import type { Palette } from './render3d';

export interface ClockColors {
  /** the two faces: the one that starts towards you, the other */
  faces: [string, string];
  dial: string;
  hand: string;
  /** the hand of a dial at twelve */
  handDone: string;
  pinUp: string;
  pinDown: string;
}

/** how far each dial is turned right now (hours, fractional while a wheel turns) */
export function drawClock(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  state: ClockState,
  dials: number[],
  colors: ClockColors,
  palette: Palette,
) {
  void palette;
  const big = Math.min(height * 0.96, width * 0.6);
  const small = big * 0.62;
  const gap = (width - big - small) / 3;
  const front = state.flipped ? 9 : 0;
  const back = state.flipped ? 0 : 9;
  // pins are kept as seen from the first side; from the other side they are mirrored and the other way up
  const otherPins = [state.pins[1], state.pins[0], state.pins[3], state.pins[2]].map((p) => 1 - p);
  const nearPins = state.flipped ? otherPins : state.pins;
  const farPins = state.flipped ? state.pins : otherPins;
  drawFace(ctx, gap, (height - big) / 2, big, dials.slice(front, front + 9), nearPins, false, colors, colors.faces[state.flipped ? 1 : 0]);
  // the far side, as you would see it after turning the clock over
  drawFace(ctx, gap * 2 + big, (height - small) / 2, small, dials.slice(back, back + 9), farPins, true, colors, colors.faces[state.flipped ? 0 : 1]);
}

function drawFace(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  dials: number[],
  pins: number[],
  dim: boolean,
  colors: ClockColors,
  face: string,
) {
  const r = size * 0.12;
  ctx.save();
  ctx.globalAlpha = dim ? 0.75 : 1;
  // the face: a rounded square
  roundRect(ctx, x, y, size, size, size * 0.18);
  ctx.fillStyle = face;
  ctx.fill();
  const cell = size / 3;
  for (let i = 0; i < 9; i++) {
    const cx = x + cell * (i % 3) + cell / 2;
    const cy = y + cell * Math.floor(i / 3) + cell / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.25, 0, Math.PI * 2);
    ctx.fillStyle = colors.dial;
    ctx.fill();
    // twelve marks: a small dot at the top
    ctx.beginPath();
    ctx.arc(cx, cy - r * 1.42, r * 0.09, 0, Math.PI * 2);
    ctx.fillStyle = colors.dial;
    ctx.fill();
    const hours = dials[i];
    const a = (hours / 12) * Math.PI * 2;
    const done = Math.abs(((hours % 12) + 12) % 12) < 1e-3;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a);
    ctx.beginPath();
    ctx.moveTo(-r * 0.2, 0);
    ctx.lineTo(0, -r * 1.05);
    ctx.lineTo(r * 0.2, 0);
    ctx.arc(0, 0, r * 0.2, 0, Math.PI);
    ctx.closePath();
    ctx.fillStyle = done ? colors.handDone : colors.hand;
    ctx.fill();
    ctx.restore();
  }
  // pins between the dials: UR, UL, DR, DL
  const pinAt = [
    [2, 1],
    [1, 1],
    [2, 2],
    [1, 2],
  ];
  pins.forEach((p, i) => {
    const px = x + cell * pinAt[i][0];
    const py = y + cell * pinAt[i][1];
    ctx.beginPath();
    ctx.arc(px, py, r * 0.32, 0, Math.PI * 2);
    ctx.fillStyle = p === 0 ? colors.pinUp : colors.pinDown;
    ctx.fill();
  });
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
