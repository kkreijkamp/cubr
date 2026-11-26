// A pretend GAN cube (gen 2, 3 or 4) for the driver tests, and for trying the smart cube input in a
// browser without one (the dev server can import this file and hand its device to the page).
import { Aes128 } from '../bluetooth/aes128';
import { GAN_KEYS, macBytes, withMac } from '../bluetooth/keys';
import { decode, encode } from '../bluetooth/cubes/crypt';
import { CubieCube } from '../cube/cubie';
import { FakeCharacteristic, FakeDevice, FakeService } from './fakeBluetooth';

export const MAC = 'AB:12:34:56:78:9A';

export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** a bit writer, most significant bit first (the GAN messages' field layout) */
export class Bits {
  b: number[];
  constructor(n: number) {
    this.b = Array(n * 8).fill(0);
  }
  set(from: number, len: number, value: number) {
    for (let i = 0; i < len; i++) this.b[from + i] = (value >> (len - 1 - i)) & 1;
    return this;
  }
  /** a little-endian field: low byte first */
  le(from: number, bytes: number, value: number) {
    for (let k = 0; k < bytes; k++) this.set(from + k * 8, 8, (value >>> (8 * k)) & 0xff);
    return this;
  }
  bytes() {
    const out: number[] = [];
    for (let i = 0; i < this.b.length; i += 8) out.push(parseInt(this.b.slice(i, i + 8).join(''), 2));
    return out;
  }
}

/** a cube state as GAN sends it: 7 corners (3 bit place, 2 bit twist), 11 edges (4 bit place, 1 bit flip) */
export function cubieBits(w: Bits, cc: CubieCube, corner: [number, number], edge: [number, number]) {
  for (let i = 0; i < 7; i++) {
    w.set(corner[0] + i * 3, 3, cc.ca[i] & 7);
    w.set(corner[1] + i * 2, 2, cc.ca[i] >> 3);
  }
  for (let i = 0; i < 11; i++) {
    w.set(edge[0] + i * 4, 4, cc.ea[i] >> 1);
    w.set(edge[1] + i, 1, cc.ea[i] & 1);
  }
}

export const quarter = (r: () => number) => 'URFDLB'[Math.floor(r() * 6)] + (r() < 0.5 ? ' ' : "'");

const UUIDS = {
  2: ['6e400001-b5a3-f393-e0a9-e50e24dc4179', '28be4cb6-cd67-11e9-a32f-2a2ae2dbcce4', '28be4a4a-cd67-11e9-a32f-2a2ae2dbcce4'],
  3: ['8653000a-43e6-47b7-9cb0-5fc21d4ae340', '8653000b-43e6-47b7-9cb0-5fc21d4ae340', '8653000c-43e6-47b7-9cb0-5fc21d4ae340'],
  4: ['00000010-0000-fff7-fff6-fff5fff4fff0', '0000fff6-0000-1000-8000-00805f9b34fb', '0000fff5-0000-1000-8000-00805f9b34fb'],
} as const;

/**
 * A pretend GAN cube of one generation: it answers the page's requests and sends its moves, losing
 * some messages on the way, and answers requests for its move history (gen3/4).
 */
export class SimGan {
  read: FakeCharacteristic;
  write: FakeCharacteristic;
  device: FakeDevice;
  cube = new CubieCube();
  cnt = 200;
  devTs = 50_000;
  recent: { m: string; dt: number }[] = [];
  history = new Map<number, string>();
  aes: Aes128;
  requests: number[][] = [];
  constructor(
    readonly version: 2 | 3 | 4,
    name = 'GAN12 ui',
  ) {
    const [svc, rd, wr] = UUIDS[version];
    this.read = new FakeCharacteristic(rd);
    this.write = new FakeCharacteristic(wr);
    this.device = new FakeDevice(name, [new FakeService(svc, [this.read, this.write])]);
    this.aes = new Aes128(withMac(GAN_KEYS[2], macBytes(MAC)));
    this.aes.iv = withMac(GAN_KEYS[3], macBytes(MAC));
    this.write.onWrite = (enc) => this.request(decode(this.aes, enc));
  }
  send(plain: number[]) {
    this.read.notify(encode(this.aes, plain));
  }
  request(req: number[]) {
    this.requests.push(req);
    const v = this.version;
    // the facelets
    if ((v === 2 && req[0] === 4) || (v === 3 && req[0] === 0x68 && req[1] === 1) || (v === 4 && req[0] === 0xdd && req[3] === 0xed)) {
      const f = new Bits(20);
      if (v === 2) f.set(0, 4, 4).set(4, 8, this.cnt);
      else if (v === 3) f.set(0, 8, 0x55).set(8, 8, 2).set(16, 8, 18).le(24, 2, this.cnt);
      else f.set(0, 8, 0xed).set(8, 8, 18).le(16, 2, this.cnt);
      cubieBits(f, this.cube, v === 2 ? [12, 33] : v === 3 ? [40, 61] : [32, 53], v === 2 ? [47, 91] : v === 3 ? [77, 121] : [69, 113]);
      queueMicrotask(() => this.send(f.bytes()));
    }
    // the battery
    if ((v === 2 && req[0] === 9) || (v === 3 && req[0] === 0x68 && req[1] === 7)) {
      const b = new Bits(20);
      if (v === 2) b.set(0, 4, 9).set(8, 8, 77);
      else b.set(0, 8, 0x55).set(8, 8, 16).set(16, 8, 1).set(24, 8, 77);
      queueMicrotask(() => this.send(b.bytes()));
    }
    if (v === 4 && req[0] === 0xdd && req[3] === 0xef) {
      // battery: the level is the byte after `len` bytes
      queueMicrotask(() => this.send(new Bits(20).set(0, 8, 0xef).set(8, 8, 1).set(16, 8, 77).bytes()));
    }
    // the move history, newest first from `start`
    const isHistory = (v === 3 && req[0] === 0x68 && req[1] === 3) || (v === 4 && req[0] === 0xd1);
    if (isHistory) {
      const start = req[2];
      const n = req[4];
      const h = new Bits(20);
      if (v === 3)
        h.set(0, 8, 0x55)
          .set(8, 8, 6)
          .set(16, 8, n / 2 + 1)
          .set(24, 8, start);
      else
        h.set(0, 8, 0xd1)
          .set(8, 8, n / 2 + 1)
          .set(16, 8, start);
      const base = v === 3 ? 32 : 24;
      for (let k = 0; k < n; k++) {
        const m = this.history.get((start - k) & 0xff);
        h.set(base + 4 * k, 3, m ? 'DUBFLR'.indexOf(m[0]) : 7).set(base + 3 + 4 * k, 1, m?.[1] === "'" ? 1 : 0);
      }
      queueMicrotask(() => this.send(h.bytes()));
    }
  }
  /** turn a face; the message about it may get lost */
  turn(m: string, dt: number, lost: boolean) {
    this.cnt = (this.cnt + 1) & 0xff;
    this.devTs += dt;
    this.cube.move(m);
    this.recent.unshift({ m, dt });
    this.history.set(this.cnt, m);
    if (lost) return;
    const w = new Bits(20);
    const code = 'URFDLB'.indexOf(m[0]) * 2 + (m[1] === "'" ? 1 : 0);
    if (this.version === 2) {
      w.set(0, 4, 2).set(4, 8, this.cnt);
      for (let k = 0; k < 7; k++) {
        const e = this.recent[k] ?? { m: 'U ', dt: 0 };
        w.set(12 + k * 5, 5, 'URFDLB'.indexOf(e.m[0]) * 2 + (e.m[1] === "'" ? 1 : 0));
        w.set(47 + k * 16, 16, e.dt);
      }
    } else {
      const hot = [2, 32, 8, 1, 16, 4]['URFDLB'.indexOf(m[0])];
      if (this.version === 3)
        w.set(0, 8, 0x55)
          .set(8, 8, 1)
          .set(16, 8, 9)
          .le(24, 4, this.devTs)
          .le(56, 2, this.cnt)
          .set(72, 2, code & 1)
          .set(74, 6, hot);
      else
        w.set(0, 8, 0x01)
          .set(8, 8, 9)
          .le(16, 4, this.devTs)
          .le(48, 2, this.cnt)
          .set(64, 2, code & 1)
          .set(66, 6, hot);
    }
    this.send(w.bytes());
  }
}
