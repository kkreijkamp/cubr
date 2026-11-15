// The other smart cubes, csTimer's drivers: Giiker / Mi Smart (giikercube.js), GoCube and Rubik's
// Connected (gocube.js), MoYu (moyucube.js), MoYu 32 / WCU (moyu32cube.js), QiYi (qiyicube.js).
import { Aes128 } from '../aes128';
import { crc16modbus } from '../crc';
import { bytesOf, findUUID, type BtModel } from '../device';
import { macBytes, MOYU32_KEYS, QIYI_CUBE_KEY, withMac } from '../keys';
import { CubieCube, moveIndex, MOVE_CUBE, SOLVED_FACELET } from '../../cube/cubie';
import { bitString, bits, manufacturerBytes, type CubeCtx } from './context';
import { decode, encode } from './crypt';

type CubeModel = BtModel<CubeCtx> & { battery(): Promise<number | null> };
const SUFFIX = '-0000-1000-8000-00805f9b34fb';

// ---------------------------------------------------------------- Giiker
const GIIKER_C_FACELET = [
  [26, 15, 29],
  [20, 8, 9],
  [18, 38, 6],
  [24, 27, 44],
  [51, 35, 17],
  [45, 11, 2],
  [47, 0, 36],
  [53, 42, 33],
];
const GIIKER_E_FACELET = [
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
const GIIKER_KEY = [176, 81, 104, 224, 86, 137, 237, 119, 38, 26, 193, 161, 210, 126, 150, 81, 93, 13, 236, 249, 89, 235, 88, 24, 113, 81, 214, 131, 130, 199, 2, 169, 39, 165, 171, 41];

/** a Giiker state notification as [facelets, latest moves] */
export function parseGiiker(bytes: number[]): [string, string[]] {
  let raw = bytes.slice(0, 20);
  if (raw[18] === 0xa7) {
    // encrypted: each byte plus two entries of a key table picked by the last byte
    const k1 = (raw[19] >> 4) & 0xf;
    const k2 = raw[19] & 0xf;
    for (let i = 0; i < 18; i++) raw[i] += GIIKER_KEY[i + k1] + GIIKER_KEY[i + k2];
    raw = raw.slice(0, 18);
  }
  const hex: number[] = [];
  for (const b of raw) hex.push((b >> 4) & 0xf, b & 0xf);
  const eo: number[] = [];
  for (let i = 0; i < 3; i++) for (let mask = 8; mask !== 0; mask >>= 1) eo.push(hex[i + 28] & mask ? 1 : 0);
  const cc = new CubieCube();
  const coMask = [-1, 1, -1, 1, 1, -1, 1, -1];
  for (let i = 0; i < 8; i++) cc.ca[i] = (hex[i] - 1) | ((3 + hex[i + 8] * coMask[i]) % 3 << 3);
  for (let i = 0; i < 12; i++) cc.ea[i] = ((hex[i + 16] - 1) << 1) | eo[i];
  const facelet = cc.toFaceCube(GIIKER_C_FACELET, GIIKER_E_FACELET);
  const moves = hex.slice(32, 40);
  const prev: string[] = [];
  for (let i = 0; i < moves.length; i += 2) prev.push('BDLURF'[moves[i] - 1] + " 2'"[(moves[i + 1] - 1) % 7]);
  return [facelet, prev];
}

function giiker(): CubeModel {
  const DATA = `0000aadb${SUFFIX}`;
  const DATA_CHR = `0000aadc${SUFFIX}`;
  const RW = `0000aaaa${SUFFIX}`;
  const READ = `0000aaab${SUFFIX}`;
  const WRITE = `0000aaac${SUFFIX}`;
  let gatt: BluetoothRemoteGATTServer | null = null;
  let chr: BluetoothRemoteGATTCharacteristic | null = null;
  let ctx: CubeCtx | null = null;
  let name = '';
  const report = (v: DataView) => {
    const loc = performance.now();
    const [facelet, prev] = parseGiiker(bytesOf(v));
    ctx?.state(facelet, prev, [loc, loc], name);
    return facelet;
  };
  const onChange = (e: Event) => report((e.target as BluetoothRemoteGATTCharacteristic).value!);
  return {
    prefix: ['Gi', 'Mi Smart Magic Cube', 'Hi-'],
    services: [DATA, RW],
    async init(device, c) {
      await this.clear(false);
      ctx = c;
      name = device.name?.startsWith('Gi') ? 'Giiker' : 'Mi Smart';
      gatt = await device.gatt!.connect();
      chr = await (await gatt.getPrimaryService(DATA)).getCharacteristic(DATA_CHR);
      await chr.startNotifications();
      c.connected(report(await chr.readValue()));
      chr.addEventListener('characteristicvaluechanged', onChange);
    },
    async battery() {
      if (!gatt) return null;
      const service = await gatt.getPrimaryService(RW);
      const read = await service.getCharacteristic(READ);
      await read.startNotifications();
      const level = new Promise<number>((resolve) => {
        const on = (e: Event) => {
          read.removeEventListener('characteristicvaluechanged', on);
          void read.stopNotifications().catch(() => undefined);
          resolve((e.target as BluetoothRemoteGATTCharacteristic).value!.getUint8(1));
        };
        read.addEventListener('characteristicvaluechanged', on);
      });
      await (await service.getCharacteristic(WRITE)).writeValue(new Uint8Array([0xb5]));
      return Promise.race([level, new Promise<null>((r) => setTimeout(() => r(null), 3000))]);
    },
    async clear() {
      if (chr) {
        chr.removeEventListener('characteristicvaluechanged', onChange);
        await chr.stopNotifications().catch(() => undefined);
        chr = null;
      }
      gatt = null;
    },
  };
}

// ---------------------------------------------------------------- GoCube / Rubik's Connected
function gocube(): CubeModel {
  const S = '-b5a3-f393-e0a9-e50e24dcca9e';
  const SERVICE = `6e400001${S}`;
  const WRITE = `6e400002${S}`;
  const READ = `6e400003${S}`;
  const WRITE_BATTERY = 50;
  const WRITE_STATE = 51;
  const axisPerm = [5, 2, 0, 3, 1, 4];
  const facePerm = [0, 1, 2, 5, 8, 7, 6, 3];
  const faceOffset = [0, 0, 6, 2, 0, 0];
  let read: BluetoothRemoteGATTCharacteristic | null = null;
  let write: BluetoothRemoteGATTCharacteristic | null = null;
  let ctx: CubeCtx | null = null;
  let name = '';
  let level: number | null = null;
  let movesSinceSync = 100;
  let curFacelet = SOLVED_FACELET;
  let curCubie = new CubieCube();
  let prevCubie = new CubieCube();
  let prevMoves: string[] = [];
  const onChange = (e: Event) => {
    const v = (e.target as BluetoothRemoteGATTCharacteristic).value!;
    const loc = performance.now();
    if (v.byteLength < 4) return;
    if (v.getUint8(0) !== 0x2a || v.getUint8(v.byteLength - 2) !== 0x0d || v.getUint8(v.byteLength - 1) !== 0x0a) return;
    const type = v.getUint8(2);
    const len = v.byteLength - 6;
    if (type === 1) {
      for (let i = 0; i < len; i += 2) {
        const axis = axisPerm[v.getUint8(3 + i) >> 1];
        const power = [0, 2][v.getUint8(3 + i) & 1];
        CubieCube.mult(prevCubie, MOVE_CUBE[axis * 3 + power], curCubie);
        curFacelet = curCubie.toFaceCube();
        prevMoves.unshift('URFDLB'[axis] + " 2'"[power]);
        if (prevMoves.length > 8) prevMoves = prevMoves.slice(0, 8);
        ctx?.state(curFacelet, prevMoves, [loc, loc], name);
        [curCubie, prevCubie] = [prevCubie, curCubie];
        if (++movesSinceSync > 20) {
          movesSinceSync = 0;
          void write?.writeValue(new Uint8Array([WRITE_STATE])).catch(() => undefined);
        }
      }
    } else if (type === 2) {
      // the cube's own state: csTimer parses it but only keeps it in a scratch cube (the state carries
      // on from the moves), so the same here
      const facelet: string[] = [];
      for (let a = 0; a < 6; a++) {
        const axis = axisPerm[a] * 9;
        const aoff = faceOffset[a];
        facelet[axis + 4] = 'BFUDRL'[v.getUint8(3 + a * 9)];
        for (let i = 0; i < 8; i++) facelet[axis + facePerm[(i + aoff) % 8]] = 'BFUDRL'[v.getUint8(3 + a * 9 + i + 1)];
      }
      const f = facelet.join('');
      if (f !== curFacelet) curCubie.fromFacelet(f);
    } else if (type === 5) {
      level = v.getUint8(3);
      ctx?.battery(level, name);
    }
  };
  return {
    prefix: ['GoCube', 'Rubiks'],
    services: [SERVICE],
    async init(device, c) {
      await this.clear(false);
      ctx = c;
      name = device.name?.startsWith('GoCube') ? 'GoCube' : 'Rubiks Connected';
      const gatt = await device.gatt!.connect();
      const service = await gatt.getPrimaryService(SERVICE);
      write = await service.getCharacteristic(WRITE);
      read = await service.getCharacteristic(READ);
      await read.startNotifications();
      read.addEventListener('characteristicvaluechanged', onChange);
      await write.writeValue(new Uint8Array([WRITE_STATE]));
    },
    async battery() {
      if (!write) return null;
      await write.writeValue(new Uint8Array([WRITE_BATTERY]));
      await new Promise((r) => setTimeout(r, 1000));
      return level;
    },
    async clear() {
      if (read) {
        read.removeEventListener('characteristicvaluechanged', onChange);
        await read.stopNotifications().catch(() => undefined);
        read = null;
      }
      write = null;
      level = null;
      movesSinceSync = 100;
      curFacelet = SOLVED_FACELET;
      curCubie = new CubieCube();
      prevCubie = new CubieCube();
      prevMoves = [];
    },
  };
}

// ---------------------------------------------------------------- MoYu (MHC)
/** MoYu turn notifications: each face's rotation in ninths, a move when it crosses the middle */
export class MoyuTurns {
  private faceStatus = [0, 0, 0, 0, 0, 0];
  /** the moves in a notification, with their device times */
  read(d: number[]): [string, number][] {
    const out: [string, number][] = [];
    const n = d[0];
    if (d.length < 1 + n * 6) return out;
    for (let i = 0; i < n; i++) {
      const o = 1 + i * 6;
      let ts = ((d[o + 1] << 24) | (d[o] << 16) | (d[o + 3] << 8) | d[o + 2]) >>> 0;
      ts = Math.round((ts / 65536) * 1000);
      const face = d[o + 4];
      const dir = Math.round(d[o + 5] / 36);
      const prevRot = this.faceStatus[face];
      const curRot = prevRot + dir;
      this.faceStatus[face] = (curRot + 9) % 9;
      const axis = [3, 4, 5, 1, 2, 0][face];
      let pow: number;
      if (prevRot >= 5 && curRot <= 4) pow = 2;
      else if (prevRot <= 4 && curRot >= 5) pow = 0;
      else continue;
      out.push(['URFDLB'[axis] + " 2'"[pow], ts]);
    }
    return out;
  }
}

function moyu(): CubeModel {
  const SERVICE = `00001000${SUFFIX}`;
  const CHR = { write: `00001001${SUFFIX}`, read: `00001002${SUFFIX}`, turn: `00001003${SUFFIX}`, gyro: `00001004${SUFFIX}` };
  let chrs: BluetoothRemoteGATTCharacteristic[] = [];
  let ctx: CubeCtx | null = null;
  let name = '';
  let turns = new MoyuTurns();
  let curCubie = new CubieCube();
  let prevCubie = new CubieCube();
  let prevMoves: string[] = [];
  const onTurn = (e: Event) => {
    const loc = performance.now();
    for (const [move, ts] of turns.read(bytesOf((e.target as BluetoothRemoteGATTCharacteristic).value!))) {
      CubieCube.mult(prevCubie, MOVE_CUBE[moveIndex(move)], curCubie);
      prevMoves.unshift(move);
      if (prevMoves.length > 8) prevMoves = prevMoves.slice(0, 8);
      ctx?.state(curCubie.toFaceCube(), prevMoves, [ts, loc], name);
      [curCubie, prevCubie] = [prevCubie, curCubie];
    }
  };
  return {
    prefix: ['MHC'],
    services: [SERVICE],
    async init(device, c) {
      await this.clear(false);
      ctx = c;
      name = device.name ?? 'MoYu';
      const gatt = await device.gatt!.connect();
      const all = await (await gatt.getPrimaryService(SERVICE)).getCharacteristics();
      const turn = findUUID(all, CHR.turn);
      if (!turn) throw new Error("this MoYu cube doesn't answer the way cubr expects");
      chrs = [turn];
      turn.addEventListener('characteristicvaluechanged', onTurn);
      await turn.startNotifications();
      // csTimer listens to the read and gyro characteristics too, only to log them
      for (const u of [CHR.read, CHR.gyro]) {
        const x = findUUID(all, u);
        if (x) {
          chrs.push(x);
          void x.startNotifications().catch(() => undefined);
        }
      }
    },
    async battery() {
      return null;
    },
    async clear() {
      for (const x of chrs) await x.stopNotifications().catch(() => undefined);
      chrs[0]?.removeEventListener('characteristicvaluechanged', onTurn);
      chrs = [];
      turns = new MoyuTurns();
      curCubie = new CubieCube();
      prevCubie = new CubieCube();
      prevMoves = [];
    },
  };
}

// ---------------------------------------------------------------- MoYu 32 (WCU)
/** company ids a MoYu 32 MAC may be advertised under (an unbound cube 0x0000, a bound one the account id's high bytes) */
export const MOYU32_CICS = [0x0000, ...Array.from({ length: 255 }, (_, i) => (i + 1) << 8)];

/** the facelets in a MoYu 32 state message: faces in FBUDLR order, 3 bits a sticker, read as URFDLB */
export function moyu32Facelet(v: string): string {
  const state: string[] = [];
  const faces = [2, 5, 0, 3, 4, 1];
  for (let i = 0; i < 6; i++) {
    const face = v.slice(faces[i] * 24, 24 + faces[i] * 24);
    for (let j = 0; j < 8; j++) {
      state.push('FBUDLR'[parseInt(face.slice(j * 3, 3 + j * 3), 2)]);
      if (j === 3) state.push('FBUDLR'[faces[i]]);
    }
  }
  return state.join('');
}

function moyu32(): CubeModel & { debug: Record<string, unknown> } {
  const SERVICE = '0783b03e-7735-b5a0-1760-a305d2795cb0';
  const READ = '0783b03e-7735-b5a0-1760-a305d2795cb1';
  const WRITE = '0783b03e-7735-b5a0-1760-a305d2795cb2';
  let read: BluetoothRemoteGATTCharacteristic | null = null;
  let write: BluetoothRemoteGATTCharacteristic | null = null;
  let ctx: CubeCtx | null = null;
  let aes: Aes128 | null = null;
  let name = '';
  let prevMoves: string[] = [];
  let timeOffs: number[] = [];
  let prevCubie = new CubieCube();
  let curCubie = new CubieCube();
  let deviceTime = 0;
  let deviceTimeOffset = 0;
  let moveCnt = -1;
  let prevMoveCnt = -1;
  let level: number | null = null;
  let bad = 0;

  const send = (op: number) => write?.writeValue(new Uint8Array(encode(aes, [op, ...Array(19).fill(0)])));

  function updateMoveTimes(loc: number) {
    let moveDiff = (moveCnt - prevMoveCnt) & 0xff;
    prevMoveCnt = moveCnt;
    if (moveDiff > prevMoves.length) moveDiff = prevMoves.length;
    let calcTs = deviceTime + deviceTimeOffset;
    for (let i = moveDiff - 1; i >= 0; i--) calcTs += timeOffs[i];
    if (!deviceTime || Math.abs(loc - calcTs) > 2000) deviceTime += loc - calcTs;
    for (let i = moveDiff - 1; i >= 0; i--) {
      CubieCube.mult(prevCubie, MOVE_CUBE[moveIndex(prevMoves[i])], curCubie);
      deviceTime += timeOffs[i];
      ctx?.state(curCubie.toFaceCube(), prevMoves.slice(i), [deviceTime, i === 0 ? loc : null], name);
      [curCubie, prevCubie] = [prevCubie, curCubie];
    }
    deviceTimeOffset = loc - deviceTime;
  }

  function parse(raw: number[]) {
    const loc = performance.now();
    const v = bitString(decode(aes, raw));
    const type = bits(v, 0, 8);
    if (type === 163) {
      // only the first state matters (moves carry on from it)
      if (prevMoveCnt !== -1) return;
      moveCnt = bits(v, 152, 160);
      const facelet = moyu32Facelet(v.slice(8, 152));
      if (!new CubieCube().fromFacelet(facelet)?.verify()) return wrongKey();
      ctx?.state(facelet, [], [null, loc], name);
      prevCubie.fromFacelet(facelet);
      prevMoveCnt = moveCnt;
      ctx?.connected(facelet);
    } else if (type === 164) {
      level = bits(v, 8, 16);
      ctx?.battery(level, name);
    } else if (type === 165) {
      moveCnt = bits(v, 88, 96);
      if (moveCnt === prevMoveCnt || prevMoveCnt === -1) return;
      timeOffs = [];
      prevMoves = [];
      let invalid = false;
      for (let i = 0; i < 5; i++) {
        const m = bits(v, 96 + i * 5, 101 + i * 5);
        timeOffs[i] = bits(v, 8 + i * 16, 24 + i * 16);
        prevMoves[i] = 'FBUDLR'[m >> 1] + " '"[m & 1];
        if (m >= 12) {
          prevMoves[i] = 'U ';
          invalid = true;
        }
      }
      if (invalid) wrongKey();
      else updateMoveTimes(loc);
    }
  }

  let retryKey: (() => void) | null = null;
  function wrongKey() {
    if (++bad === 3) retryKey?.();
  }

  const onChange = (e: Event) => {
    if (aes) parse(bytesOf((e.target as BluetoothRemoteGATTCharacteristic).value!));
  };

  return {
    prefix: ['WCU_MY3'],
    services: [SERVICE],
    cics: MOYU32_CICS,
    debug: { parse },
    async init(device, c, group) {
      await this.clear(false);
      ctx = c;
      name = (device.name ?? '').trim();
      let found: string | null = null;
      try {
        const view = manufacturerBytes(await group.waitForAdvertisement(), MOYU32_CICS);
        if (view && view.byteLength >= 6) found = Array.from({ length: 6 }, (_, i) => view.getUint8(view.byteLength - i - 1).toString(16).padStart(2, '0')).join(':');
      } catch {
        /* saved or asked for */
      }
      const gatt = await device.gatt!.connect();
      const chrs = await (await gatt.getPrimaryService(SERVICE)).getCharacteristics();
      read = findUUID(chrs, READ);
      write = findUUID(chrs, WRITE);
      if (!read) throw new Error("this MoYu cube doesn't answer the way cubr expects");
      read.addEventListener('characteristicvaluechanged', onChange);
      await read.startNotifications();
      const suggested = /^WCU_MY32_[0-9A-F]{4}$/.test(name) ? `CF:30:16:00:${name.slice(9, 11)}:${name.slice(11, 13)}` : null;
      const useMac = async (opts: { force?: boolean; wrong?: boolean } = {}) => {
        const mac = await c.mac(name, opts.force ? null : found, suggested, opts);
        if (!mac) throw new Error('the cube needs its MAC address to connect');
        const m = macBytes(mac);
        aes = new Aes128(withMac(MOYU32_KEYS[0], m));
        aes.iv = withMac(MOYU32_KEYS[1], m);
      };
      await useMac();
      retryKey = () => {
        void useMac({ force: true, wrong: true })
          .then(() => {
            bad = 0;
            prevMoveCnt = -1;
            return send(163);
          })
          .catch(() => c.lost());
      };
      await send(161);
      await send(163);
      await send(164);
    },
    async battery() {
      await send(164);
      return level;
    },
    async clear() {
      if (read) {
        read.removeEventListener('characteristicvaluechanged', onChange);
        await read.stopNotifications().catch(() => undefined);
        read = null;
      }
      write = null;
      aes = null;
      prevMoves = [];
      timeOffs = [];
      prevCubie = new CubieCube();
      curCubie = new CubieCube();
      deviceTime = 0;
      deviceTimeOffset = 0;
      moveCnt = -1;
      prevMoveCnt = -1;
      level = null;
      bad = 0;
      retryKey = null;
    },
  };
}

// ---------------------------------------------------------------- QiYi
const QY_CICS = [0x0504];

/** a QiYi message: 0xFE, length, the content, CRC-16/MODBUS little endian, zero padded to 16-byte AES blocks */
export function qiyiCubeMessage(aes: Aes128, content: number[]): number[] {
  const msg = [0xfe, 4 + content.length, ...content];
  const crc = crc16modbus(msg);
  msg.push(crc & 0xff, crc >> 8);
  while (msg.length % 16) msg.push(0);
  const out: number[] = [];
  for (let i = 0; i < msg.length; i += 16) out.push(...aes.encrypt(msg.slice(i, i + 16)));
  return out;
}

/** decrypts a QiYi notification; null if its checksum is off */
export function qiyiCubeRead(aes: Aes128, enc: number[]): number[] | null {
  let msg: number[] = [];
  for (let i = 0; i < enc.length; i += 16) msg = msg.concat(aes.decrypt(enc.slice(i, i + 16)));
  msg = msg.slice(0, msg[1]);
  if (msg.length < 3 || crc16modbus(msg) !== 0) return null;
  return msg;
}

/** 54 facelets, two to a byte (low nibble first), colours as LRDUFB */
export function qiyiFacelet(bytes: number[]): string {
  let s = '';
  for (let i = 0; i < 54; i++) s += 'LRDUFB'[(bytes[i >> 1] >> ((i % 2) << 2)) & 0xf];
  return s;
}

function qiyi(): CubeModel & { debug: Record<string, unknown> } {
  const SERVICE = `0000fff0${SUFFIX}`;
  const CHR = `0000fff6${SUFFIX}`;
  const aes = new Aes128(QIYI_CUBE_KEY);
  let chr: BluetoothRemoteGATTCharacteristic | null = null;
  let ctx: CubeCtx | null = null;
  let name = '';
  let curCubie = new CubieCube();
  let prevCubie = new CubieCube();
  let prevMoves: string[] = [];
  let lastTs = 0;
  let level: number | null = null;

  const send = (content: number[]) => chr?.writeValue(new Uint8Array(qiyiCubeMessage(aes, content)));

  function parse(msg: number[]) {
    const loc = performance.now();
    if (msg[0] !== 0xfe) return;
    const op = msg[2];
    const ts = ((msg[3] << 24) | (msg[4] << 16) | (msg[5] << 8) | msg[6]) >>> 0;
    if (op === 0x2) {
      // hello: answer it, take the state
      level = msg[35];
      void send(msg.slice(2, 7))?.catch(() => undefined);
      const facelet = qiyiFacelet(msg.slice(7, 34));
      ctx?.state(facelet, [], [Math.trunc(ts / 1.6), loc], name);
      prevCubie.fromFacelet(facelet);
      ctx?.battery(level, name);
      ctx?.connected(facelet);
    } else if (op === 0x3) {
      void send(msg.slice(2, 7))?.catch(() => undefined);
      // this move, and any the cube says came since the last message (its history)
      const todo: [number, number][] = [[msg[34], ts]];
      while (todo.length < 10) {
        const off = 91 - 5 * todo.length;
        const hisTs = ((msg[off] << 24) | (msg[off + 1] << 16) | (msg[off + 2] << 8) | msg[off + 3]) >>> 0;
        if (hisTs <= lastTs) break;
        todo.push([msg[off + 4], hisTs]);
      }
      const calls: [string, string[], [number, number]][] = [];
      let curFacelet = '';
      for (let i = todo.length - 1; i >= 0; i--) {
        const axis = [4, 1, 3, 0, 2, 5][(todo[i][0] - 1) >> 1];
        if (axis === undefined) continue;
        const power = [0, 2][todo[i][0] & 1];
        CubieCube.mult(prevCubie, MOVE_CUBE[axis * 3 + power], curCubie);
        prevMoves.unshift('URFDLB'[axis] + " 2'"[power]);
        prevMoves = prevMoves.slice(0, 8);
        curFacelet = curCubie.toFaceCube();
        calls.push([curFacelet, prevMoves.slice(), [Math.trunc(todo[i][1] / 1.6), loc]]);
        [curCubie, prevCubie] = [prevCubie, curCubie];
      }
      const facelet = qiyiFacelet(msg.slice(7, 34));
      if (facelet !== curFacelet) {
        // out of step: the cube's own state wins
        curCubie.fromFacelet(facelet);
        ctx?.state(facelet, prevMoves, [Math.trunc(ts / 1.6), loc], name);
        [curCubie, prevCubie] = [prevCubie, curCubie];
      } else {
        for (const c of calls) ctx?.state(c[0], c[1], c[2], name);
      }
      if (msg[35] !== level) {
        level = msg[35];
        ctx?.battery(level, name);
      }
    }
    lastTs = ts;
  }

  const onChange = (e: Event) => {
    const msg = qiyiCubeRead(aes, bytesOf((e.target as BluetoothRemoteGATTCharacteristic).value!));
    if (msg) parse(msg);
    else ctx?.log('[qiyi] checksum error');
  };

  return {
    prefix: ['QY-QYSC', 'XMD-TornadoV4-i'],
    services: [SERVICE],
    cics: QY_CICS,
    debug: { parse },
    async init(device, c, group) {
      await this.clear(false);
      ctx = c;
      name = (device.name ?? '').trim();
      let found: string | null = null;
      try {
        const view = manufacturerBytes(await group.waitForAdvertisement(), QY_CICS);
        if (view && view.byteLength >= 6) found = Array.from({ length: 6 }, (_, i) => view.getUint8(5 - i).toString(16).padStart(2, '0')).join(':');
      } catch {
        /* saved or asked for */
      }
      const gatt = await device.gatt!.connect();
      chr = findUUID(await (await gatt.getPrimaryService(SERVICE)).getCharacteristics(), CHR);
      if (!chr) throw new Error("this QiYi cube doesn't answer the way cubr expects");
      chr.addEventListener('characteristicvaluechanged', onChange);
      await chr.startNotifications();
      const suggested = /^(QY-QYSC|XMD-TornadoV4-i)-.-[0-9A-F]{4}$/.test(name) ? `CC:A3:00:00:${name.slice(-4, -2)}:${name.slice(-2)}` : null;
      const mac = await c.mac(name, found, suggested);
      if (!mac) throw new Error('the cube needs its MAC address to connect');
      await send([0x00, 0x6b, 0x01, 0x00, 0x00, 0x22, 0x06, 0x00, 0x02, 0x08, 0x00, ...macBytes(mac).reverse()]);
    },
    async battery() {
      return level;
    },
    async clear() {
      if (chr) {
        chr.removeEventListener('characteristicvaluechanged', onChange);
        await chr.stopNotifications().catch(() => undefined);
        chr = null;
      }
      curCubie = new CubieCube();
      prevCubie = new CubieCube();
      prevMoves = [];
      lastTs = 0;
      level = null;
    },
  };
}

export const otherCubes = () => ({ giiker: giiker(), gocube: gocube(), moyu: moyu(), moyu32: moyu32(), qiyi: qiyi() });
