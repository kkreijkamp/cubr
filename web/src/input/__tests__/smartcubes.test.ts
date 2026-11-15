import { describe, expect, it } from 'vitest';
import { Aes128 } from '../bluetooth/aes128';
import { encode } from '../bluetooth/cubes/crypt';
import { moyu32Facelet, MoyuTurns, otherCubes, parseGiiker, qiyiCubeMessage, qiyiCubeRead, qiyiFacelet } from '../bluetooth/cubes/others';
import { macBytes, MOYU32_KEYS, QIYI_CUBE_KEY, withMac } from '../bluetooth/keys';
import { CubieCube, SOLVED_FACELET } from '../cube/cubie';
import { FakeCharacteristic, FakeDevice, FakeService, tick } from './fakeBluetooth';

const S = '-0000-1000-8000-00805f9b34fb';
const MAC = 'CC:A3:00:00:12:34';

function ctxLog() {
  const states: { facelet: string; moves: string[]; ts: [number | null, number | null] }[] = [];
  const battery: number[] = [];
  const connected: string[] = [];
  const macs: (string | null)[] = [];
  const ctx = {
    state: (facelet: string, moves: string[], ts: [number | null, number | null]) => states.push({ facelet, moves: moves.slice(), ts }),
    battery: (l: number) => battery.push(l),
    mac: async (_n: string, found: string | null, suggested: string | null) => {
      macs.push(found ?? suggested);
      return found ?? suggested ?? MAC;
    },
    connected: (f: string) => connected.push(f),
    log() {},
    lost() {},
  };
  return { ctx, states, battery, connected, macs };
}
const noAdverts = { waitForAdvertisement: () => Promise.reject(new Error('none')) };
const scrambled = (alg: string) => {
  const c = new CubieCube();
  for (const m of alg.split(' ')) c.move(m.length === 1 ? `${m} ` : m);
  return c;
};

// ---------------------------------------------------------------- Giiker
/** a Giiker state: 40 nibbles (corners, twists, edges, flips, the last 4 moves); its own facelet tables */
const GC = [
  [26, 15, 29],
  [20, 8, 9],
  [18, 38, 6],
  [24, 27, 44],
  [51, 35, 17],
  [45, 11, 2],
  [47, 0, 36],
  [53, 42, 33],
];
const GE = [
  [25, 28],
  [23, 12],
  [19, 7],
  [21, 41],
  [32, 16],
  [5, 10],
  [3, 37],
  [30, 43],
  [52, 34],
  [48, 14],
  [46, 1],
  [50, 39],
];
/** the Giiker-numbered pieces that show `facelet` through its tables (found piece by piece) */
function giikerCubie(facelet: string): CubieCube {
  const face = (idx: number) => 'URFDLB'[Math.floor(idx / 9)];
  const cc = new CubieCube();
  for (let c = 0; c < 8; c++)
    for (let j = 0; j < 8; j++)
      for (let o = 0; o < 3; o++) if ([0, 1, 2].every((n) => facelet[GC[c][(n + o) % 3]] === face(GC[j][n]))) cc.ca[c] = j | (o << 3);
  for (let e = 0; e < 12; e++)
    for (let j = 0; j < 12; j++)
      for (let o = 0; o < 2; o++) if ([0, 1].every((n) => facelet[GE[e][(n + o) % 2]] === face(GE[j][n]))) cc.ea[e] = (j << 1) | o;
  return cc;
}

function giikerBytes(facelet: string, moves: [number, number][], encrypt: false | [number, number] = false): number[] {
  const cc = giikerCubie(facelet);
  const hex = Array(40).fill(0);
  const coMask = [-1, 1, -1, 1, 1, -1, 1, -1];
  for (let i = 0; i < 8; i++) {
    hex[i] = (cc.ca[i] & 7) + 1;
    // the twist nibble v with (3 + v * mask) % 3 = twist, v in 1..3
    for (let v = 1; v <= 3; v++) if ((3 + v * coMask[i]) % 3 === cc.ca[i] >> 3) hex[i + 8] = v;
  }
  for (let i = 0; i < 12; i++) hex[i + 16] = (cc.ea[i] >> 1) + 1;
  for (let i = 0; i < 12; i++) if (cc.ea[i] & 1) hex[28 + Math.floor(i / 4)] |= 8 >> i % 4;
  moves.forEach(([f, p], k) => {
    hex[32 + k * 2] = f;
    hex[33 + k * 2] = p;
  });
  const bytes = Array.from({ length: 20 }, (_, i) => (hex[i * 2] << 4) | hex[i * 2 + 1]);
  if (!encrypt) return bytes;
  const KEY = [176, 81, 104, 224, 86, 137, 237, 119, 38, 26, 193, 161, 210, 126, 150, 81, 93, 13, 236, 249, 89, 235, 88, 24, 113, 81, 214, 131, 130, 199, 2, 169, 39, 165, 171, 41];
  const [k1, k2] = encrypt;
  const out = bytes.slice(0, 18).map((b, i) => (((b - KEY[i + k1] - KEY[i + k2]) % 256) + 256) % 256);
  return [...out, 0xa7, (k1 << 4) | k2];
}

describe('Giiker', () => {
  it('reads its state and latest moves, plain or encrypted', () => {
    const f = scrambled("R U F' L2 D").toFaceCube();
    // moves: face 1..6 in BDLURF order, amount 1 (cw), 3 (ccw), 2 (half) ... 9 means a half turn too
    const raw = giikerBytes(f, [
      [5, 1],
      [4, 3],
      [6, 2],
      [1, 1],
    ]);
    expect(parseGiiker(raw)).toEqual([f, ['R ', "U'", 'F2', 'B ']]);
    expect(parseGiiker(giikerBytes(f, [[5, 1]], [3, 9]))[0]).toBe(f);
    expect(parseGiiker(giikerBytes(SOLVED_FACELET, [[1, 1]]))[0]).toBe(SOLVED_FACELET);
  });

  it('connected: reads the state at once, then follows it', async () => {
    const data = new FakeCharacteristic(`0000aadc${S}`);
    let state = scrambled('R U').toFaceCube();
    data.onRead = () => giikerBytes(state, [[4, 1]]);
    const device = new FakeDevice('GiC12345', [new FakeService(`0000aadb${S}`, [data]), new FakeService(`0000aaaa${S}`, [])]);
    const { ctx, states, connected } = ctxLog();
    await otherCubes().giiker.init(device as never, ctx as never, noAdverts as never);
    expect(connected).toEqual([state]);
    state = scrambled('R U R').toFaceCube();
    data.notify(giikerBytes(state, [[5, 1]]));
    expect(states.at(-1)!.facelet).toBe(state);
    expect(states.at(-1)!.moves[0]).toBe('R ');
  });
});

// ---------------------------------------------------------------- GoCube
describe('GoCube / Rubiks Connected', () => {
  it('turns from its move messages', async () => {
    const write = new FakeCharacteristic('6e400002-b5a3-f393-e0a9-e50e24dcca9e');
    const read = new FakeCharacteristic('6e400003-b5a3-f393-e0a9-e50e24dcca9e');
    const device = new FakeDevice('GoCube_1234', [new FakeService('6e400001-b5a3-f393-e0a9-e50e24dcca9e', [write, read])]);
    const { ctx, states } = ctxLog();
    await otherCubes().gocube.init(device as never, ctx as never, noAdverts as never);
    // it asked for its state
    expect(write.writes[0]).toEqual([51]);
    // a move byte: the axis code (URFDLB index found through [5, 2, 0, 3, 1, 4]) << 1, then 1 for counter-clockwise
    const code = (m: string) => ([5, 2, 0, 3, 1, 4].indexOf('URFDLB'.indexOf(m[0])) << 1) | (m[1] === "'" ? 1 : 0);
    const alg = ['R ', "U'", 'F ', "L'", 'D ', "B'"];
    read.notify([0x2a, 0x00, 0x01, ...alg.flatMap((m) => [code(m), 0x00]), 0x00, 0x0d, 0x0a]);
    expect(states.map((s) => s.moves[0])).toEqual(alg);
    expect(states.at(-1)!.facelet).toBe(scrambled("R U' F L' D B'").toFaceCube());
    // battery
    read.notify([0x2a, 0x00, 0x05, 63, 0x00, 0x0d, 0x0a]);
    expect(await otherCubes().gocube.battery()).toBeNull();
  });
});

// ---------------------------------------------------------------- MoYu (MHC)
describe('MoYu', () => {
  it('a move when a face turns past the middle', () => {
    const t = new MoyuTurns();
    // one turn: [count, ts bytes x4, face, rotation in ninths * 36 (unsigned)]; faces D L B R F U, so 3 is R
    const msg = (face: number, ninths: number) => [1, 0, 0, 0, 0, face, ninths * 36];
    expect(t.read(msg(3, 5)).map((x) => x[0])).toEqual(['R ']);
    // a little further round is no new move
    expect(t.read(msg(3, 2))).toEqual([]);
    expect(t.read(msg(5, 5)).map((x) => x[0])).toEqual(['U ']);
    // the device time: bytes 1, 0, 3, 2 big endian, in 1/65536 s
    expect(new MoyuTurns().read([1, 0x00, 0x01, 0x00, 0x00, 3, 180])[0][1]).toBe(Math.round((0x01000000 / 65536) * 1000));
  });
});

// ---------------------------------------------------------------- MoYu 32
describe('MoYu 32 (WCU)', () => {
  const key = () => {
    const a = new Aes128(withMac(MOYU32_KEYS[0], macBytes('CF:30:16:00:AB:CD')));
    a.iv = withMac(MOYU32_KEYS[1], macBytes('CF:30:16:00:AB:CD'));
    return a;
  };
  /** facelets as MoYu 32 packs them: faces in FBUDLR order, 8 stickers of 3 bits each (no centres) */
  function packFacelet(f: string): string {
    const faces = [2, 5, 0, 3, 4, 1];
    const byFace: string[] = [];
    for (let i = 0; i < 6; i++) {
      const stickers = f.slice(i * 9, i * 9 + 9).split('');
      stickers.splice(4, 1);
      byFace[faces[i]] = stickers.map((c) => 'FBUDLR'.indexOf('URFDLB'.includes(c) ? c : c).toString(2).padStart(3, '0')).join('');
    }
    return byFace.join('');
  }
  const toBytes = (bits: string) => (bits.padEnd(160, '0').match(/.{8}/g) ?? []).map((b) => parseInt(b, 2));

  it('packs facelets the way it reads them', () => {
    const f = scrambled("R U2 F' D").toFaceCube();
    expect(moyu32Facelet(packFacelet(f))).toBe(f);
  });

  it('connected: the state, then moves with their device times', async () => {
    const read = new FakeCharacteristic('0783b03e-7735-b5a0-1760-a305d2795cb1');
    const write = new FakeCharacteristic('0783b03e-7735-b5a0-1760-a305d2795cb2');
    const device = new FakeDevice('WCU_MY32_ABCD', [new FakeService('0783b03e-7735-b5a0-1760-a305d2795cb0', [read, write])]);
    const { ctx, states, macs, connected } = ctxLog();
    const aes = key();
    const start = scrambled('L B2 U').toFaceCube();
    write.onWrite = (enc) => {
      // the page asks for info (161), the state (163), the battery (164)
      const op = encode(null, enc)[0];
      void op;
    };
    await otherCubes().moyu32.init(device as never, ctx as never, noAdverts as never);
    // the MAC its name suggests
    expect(macs).toEqual(['CF:30:16:00:AB:CD']);
    read.notify(encode(aes, toBytes((163).toString(2).padStart(8, '0') + packFacelet(start) + (10).toString(2).padStart(8, '0'))));
    expect(connected).toEqual([start]);
    // a move message: 5 time gaps (16 bits), the move counter, 5 moves (FBUDLR index << 1 | ccw), newest first
    const moves = ["R'", 'U ', 'F '];
    const gaps = [120, 340, 0, 0, 0];
    const code = (m: string) => ('FBUDLR'.indexOf(m[0]) << 1) | (m[1] === "'" ? 1 : 0);
    let bits = (165).toString(2).padStart(8, '0');
    for (const g of gaps) bits += g.toString(2).padStart(16, '0');
    bits += (13).toString(2).padStart(8, '0');
    for (let i = 0; i < 5; i++) bits += code(moves[i] ?? 'U ').toString(2).padStart(5, '0');
    read.notify(encode(aes, toBytes(bits)));
    // move counter 10 -> 13: three moves, oldest first
    expect(states.slice(1).map((s) => s.moves[0])).toEqual(['F ', 'U ', "R'"]);
    expect(states.at(-1)!.facelet).toBe(scrambled("L B2 U F U R'").toFaceCube());
    const [, a, b, c] = states.map((s) => s.ts[0]!);
    expect([b - a, c - b]).toEqual([340, 120]);
  });
});

// ---------------------------------------------------------------- QiYi
describe('QiYi', () => {
  const aes = new Aes128(QIYI_CUBE_KEY);
  const pack = (f: string) => {
    const out = Array(27).fill(0);
    for (let i = 0; i < 54; i++) out[i >> 1] |= 'LRDUFB'.indexOf(f[i]) << ((i % 2) << 2);
    return out;
  };
  /** a move byte: its axis through [4, 1, 3, 0, 2, 5], clockwise even, counter-clockwise odd */
  const mv = (m: string) => {
    const k = [4, 1, 3, 0, 2, 5].indexOf('URFDLB'.indexOf(m[0]));
    return m[1] === "'" ? 2 * k + 1 : 2 * k + 2;
  };
  const be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  /** a state change: op 3, time, facelets, this move, battery, then the history (newest at the end) */
  function change(ts: number, f: string, move: string, history: [string, number][], battery = 90) {
    const body = Array(92 - 2).fill(0);
    const msg = [0x03, ...be(ts), ...pack(f), mv(move), battery];
    for (let i = 0; i < msg.length; i++) body[i] = msg[i];
    // history slots from the end: slot k (1..9) at 91 - 5k: [ts 4][move]
    history.forEach(([m, t], k) => {
      const off = 91 - 5 * (k + 1) - 2;
      be(t).forEach((b, j) => (body[off + j] = b));
      body[off + 4] = mv(m);
    });
    return qiyiCubeMessage(aes, body);
  }

  it('messages: CRC-16/MODBUS framed, AES blocks; facelets two to a byte', () => {
    const enc = qiyiCubeMessage(aes, [0x02, 1, 2, 3, 4]);
    expect(enc.length % 16).toBe(0);
    expect(qiyiCubeRead(aes, enc)!.slice(0, 7)).toEqual([0xfe, 9, 0x02, 1, 2, 3, 4]);
    const bad = enc.slice();
    bad[3] ^= 1;
    expect(qiyiCubeRead(aes, bad)).toBeNull();
    const f = scrambled('R U').toFaceCube();
    expect(qiyiFacelet(pack(f))).toBe(f);
  });

  it('connected: hello, moves, a message it missed caught up from the history', async () => {
    const chr = new FakeCharacteristic(`0000fff6${S}`);
    const device = new FakeDevice('QY-QYSC-S-1234', [new FakeService(`0000fff0${S}`, [chr])]);
    const { ctx, states, macs, connected, battery } = ctxLog();
    await otherCubes().qiyi.init(device as never, ctx as never, noAdverts as never);
    expect(macs).toEqual(['CC:A3:00:00:12:34']);
    // its hello carried the MAC, reversed
    expect(qiyiCubeRead(aes, chr.writes[0])!.slice(13, 19)).toEqual([0x34, 0x12, 0, 0, 0xa3, 0xcc]);
    // hello from the cube: its state
    const start = scrambled('D2 F').toFaceCube();
    const hello = Array(90).fill(0);
    [0x02, ...be(1600), ...pack(start)].forEach((b, i) => (hello[i] = b));
    hello[33] = 88;
    chr.notify(qiyiCubeMessage(aes, hello));
    expect(connected).toEqual([start]);
    expect(battery).toEqual([88]);
    // R at t=3200, U at 4800 (its message lost), F at 6400 with U in the history
    chr.notify(change(3200, scrambled('D2 F R').toFaceCube(), 'R ', []));
    chr.notify(change(6400, scrambled('D2 F R U F').toFaceCube(), 'F ', [['U ', 4800], ['R ', 3200]]));
    expect(states.slice(1).map((s) => s.moves[0])).toEqual(['R ', 'U ', 'F ']);
    expect(states.at(-1)!.facelet).toBe(scrambled('D2 F R U F').toFaceCube());
    // device time: its ticks / 1.6
    expect(states.slice(1).map((s) => s.ts[0])).toEqual([2000, 3000, 4000]);
    // each message acked: op and time back
    await tick();
    expect(chr.writes.length).toBe(4);
  });

  it('out of step: the cube state it sends wins', async () => {
    const chr = new FakeCharacteristic(`0000fff6${S}`);
    const device = new FakeDevice('QY-QYSC-S-1234', [new FakeService(`0000fff0${S}`, [chr])]);
    const { ctx, states } = ctxLog();
    await otherCubes().qiyi.init(device as never, ctx as never, noAdverts as never);
    const hello = Array(90).fill(0);
    [0x02, ...be(1600), ...pack(SOLVED_FACELET)].forEach((b, i) => (hello[i] = b));
    chr.notify(qiyiCubeMessage(aes, hello));
    const real = scrambled("L2 B'").toFaceCube();
    chr.notify(change(3200, real, 'R ', []));
    expect(states.at(-1)!.facelet).toBe(real);
  });
});
