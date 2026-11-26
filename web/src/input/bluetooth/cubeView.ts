// The smart cube drawn on screen (csTimer's giikerVRC): our virtual cube kept in step with the real
// one. A new state that is the old one plus the latest few turns animates those turns; anything else
// (a reset, turns lost on the way) jumps straight to the new state.
import { CubieCube, moveIndex, MOVE_CUBE } from '../cube/cubie';
import { modelFor, type PolyModel } from '../virtual/models';
import type { Move } from '../virtual/polyPuzzle';
import { cubeFacelet } from '../virtual/renderFlat';

/** the virtual cube's faces (U F R B L D) by facelet letter */
const FACE_OF: Record<string, number> = { U: 0, F: 1, R: 2, B: 3, L: 4, D: 5 };

const undo = (c: CubieCube, m: string) => {
  const i = moveIndex(m);
  return CubieCube.mult(c, MOVE_CUBE[i - (i % 3) + 2 - (i % 3)], new CubieCube());
};

export class CubeView {
  readonly model: PolyModel;
  readonly n: 2 | 3;
  /** the state with every turn applied */
  target: Int16Array;
  /** what is drawn: the state before the turns still being animated */
  shown: Int16Array;
  queue: Move[] = [];
  active: { move: Move; progress: number }[] = [];
  /** ms a turn (0: no animation) */
  speed = 100;
  /** each sticker's place in a 54-letter facelet string */
  readonly facelet: number[];
  /** a sticker of each face, to colour a slot by */
  private rep: number[];
  private cube = new CubieCube();

  constructor(n: 2 | 3) {
    this.n = n;
    this.model = modelFor(n === 2 ? '222' : '333') as PolyModel;
    const slots = this.model.twisty.puzzle.slots;
    // a 2x2's stickers are the 3x3's corner stickers
    this.facelet = slots.map((s) => {
      const f = cubeFacelet(n, s.center, s.normal);
      if (n === 3) return f;
      const face = Math.floor(f / 4);
      const r = Math.floor((f % 4) / 2);
      const c = f % 2;
      return face * 9 + r * 6 + c * 2;
    });
    this.rep = [0, 1, 2, 3, 4, 5].map((face) => slots.findIndex((s) => s.face === face));
    this.target = this.model.solved();
    this.shown = this.target;
  }

  /** the virtual cube coloured as these facelets */
  stateOf(facelet: string): Int16Array {
    const s = new Int16Array(this.facelet.length);
    this.facelet.forEach((f, slot) => (s[slot] = this.rep[FACE_OF[facelet[f]] ?? 0]));
    return s;
  }

  /** show this state right away */
  reset(facelet: string) {
    this.cube = new CubieCube().fromFacelet(facelet) ?? new CubieCube();
    this.target = this.stateOf(facelet);
    this.shown = this.target;
    this.queue = [];
    this.active = [];
  }

  /** a new state from the cube, its latest turns newest first */
  update(facelet: string, prevMoves: string[]) {
    const next = new CubieCube().fromFacelet(facelet);
    if (!next) return;
    const corners = this.n === 2;
    const same = (a: CubieCube, b: CubieCube) => (corners ? a.cornersEqual(b) : a.isEqual(b));
    if (same(next, this.cube)) return;
    // undo the latest turns one by one until it's the state on screen
    let c = next;
    let todo: string[] | null = null;
    for (let i = 0; i < prevMoves.length; i++) {
      if (moveIndex(prevMoves[i]) < 0) break;
      c = undo(c, prevMoves[i]);
      if (same(c, this.cube)) {
        todo = prevMoves.slice(0, i + 1).reverse();
        break;
      }
    }
    const moves = todo?.map((m) => this.model.parse(m.trim())?.[0]);
    if (!moves || moves.some((m) => !m) || moves.length >= 5 || this.speed <= 0) {
      this.reset(facelet);
      return;
    }
    this.cube = next;
    for (const m of moves as Move[]) {
      this.target = this.model.apply(this.target, m);
      this.queue.push(m);
    }
  }

  /** advance the animation by dt ms (csTimer's: quicker the more turns wait); true while turning */
  step(dt: number): boolean {
    if (this.speed <= 0) {
      this.queue = [];
      this.active = [];
      this.shown = this.target;
      return false;
    }
    if (this.active.length === 0 && this.queue.length > 0) this.active.push({ move: this.queue.shift()!, progress: 0 });
    while (this.queue.length > 0 && this.active.every((a) => this.model.parallel(a.move, this.queue[0])))
      this.active.push({ move: this.queue.shift()!, progress: 0 });
    if (this.active.length === 0) return false;
    const inc = Math.min(1, Math.max(0.0001, (dt / this.speed) * ((this.queue.length + 2) / 2)));
    for (const a of this.active) a.progress += inc;
    if (this.active[0].progress >= 1) {
      for (const a of this.active) this.shown = this.model.apply(this.shown, a.move);
      this.active = [];
    }
    return true;
  }
}
