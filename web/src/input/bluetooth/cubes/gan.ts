// GAN smart cubes, csTimer's hardware/gancube.js: gen1 (read in a loop), gen2 (encrypted
// notifications), gen3 and gen4 (a move buffer, with lost moves asked for again from the cube's move
// history), and the GAN 251 UI 2x2 (gen4 with its own key).
import { Aes128 } from '../aes128';
import { bytesOf, findUUID, type BtGroup, type BtModel } from '../device';
import { GAN_KEYS, macBytes, withMac } from '../keys';
import { CubieCube, moveIndex, MOVE_CUBE, SOLVED_FACELET } from '../../cube/cubie';
import { bitString, bits, manufacturerBytes, type CubeCtx } from './context';
import { decode, encode } from './crypt';

const SUFFIX = '-0000-1000-8000-00805f9b34fb';
const SERVICE_META = `0000180a${SUFFIX}`;
const CHR_VERSION = `00002a28${SUFFIX}`;
const CHR_HARDWARE = `00002a23${SUFFIX}`;
const SERVICE_DATA = `0000fff0${SUFFIX}`;
const CHR_F2 = `0000fff2${SUFFIX}`; // cube state, 3 bits a facelet
const CHR_F5 = `0000fff5${SUFFIX}`; // move counter and the latest moves
const CHR_F6 = `0000fff6${SUFFIX}`; // times between the latest moves
const CHR_F7 = `0000fff7${SUFFIX}`; // battery
const SERVICE_V2 = '6e400001-b5a3-f393-e0a9-e50e24dc4179';
const CHR_V2_READ = '28be4cb6-cd67-11e9-a32f-2a2ae2dbcce4';
const CHR_V2_WRITE = '28be4a4a-cd67-11e9-a32f-2a2ae2dbcce4';
const SERVICE_V3 = '8653000a-43e6-47b7-9cb0-5fc21d4ae340';
const CHR_V3_READ = '8653000b-43e6-47b7-9cb0-5fc21d4ae340';
const CHR_V3_WRITE = '8653000c-43e6-47b7-9cb0-5fc21d4ae340';
const SERVICE_V4 = '00000010-0000-fff7-fff6-fff5fff4fff0';
const CHR_V4_READ = `0000fff6${SUFFIX}`;
const CHR_V4_WRITE = `0000fff5${SUFFIX}`;
/** company ids a GAN cube's MAC may be advertised under: 0x0001..0xFF01 */
export const GAN_CICS = Array.from({ length: 256 }, (_, i) => (i << 8) | 0x01);

/** the cube state in a gen2/3/4 facelets message: 7 corners and 11 edges, the last of each worked out */
export function ganCubie(v: string, corner: [number, number], edge: [number, number]): CubieCube {
  const cc = new CubieCube();
  let echk = 0;
  let cchk = 0xf00;
  for (let i = 0; i < 7; i++) {
    const perm = bits(v, corner[0] + i * 3, corner[0] + 3 + i * 3);
    const ori = bits(v, corner[1] + i * 2, corner[1] + 2 + i * 2);
    cchk -= ori << 3;
    cchk ^= perm;
    cc.ca[i] = (ori << 3) | perm;
  }
  cc.ca[7] = ((cchk & 0xff8) % 24) | (cchk & 0x7);
  for (let i = 0; i < 11; i++) {
    const perm = bits(v, edge[0] + i * 4, edge[0] + 4 + i * 4);
    const ori = bits(v, edge[1] + i, edge[1] + 1 + i);
    echk ^= (perm << 1) | ori;
    cc.ea[i] = (perm << 1) | ori;
  }
  cc.ea[11] = echk;
  return cc;
}

/** a move-number window check modulo 256: (start, end), either end closed if asked */
export function inRange(start: number, end: number, n: number, closedStart = false, closedEnd = false): boolean {
  return ((end - start) & 0xff) >= ((n - start) & 0xff) && (closedStart || ((start - n) & 0xff) > 0) && (closedEnd || ((end - n) & 0xff) > 0);
}

type Buffered = [number, string, number | null, number | null];

export function ganCube(): BtModel<CubeCtx> & { battery(): Promise<number | null>; debug: Record<string, unknown> } {
  let ctx: CubeCtx | null = null;
  let group: BtGroup<CubeCtx> | null = null;
  let device: BluetoothDevice | null = null;
  let aes: Aes128 | null = null;
  let deviceName = '';
  let deviceMac: string | null = null;
  let is251 = false;
  let version: 1 | 2 | 3 | 4 = 2;
  let keyVersion = 0;
  let chr: Record<string, BluetoothRemoteGATTCharacteristic | null> = {};
  let listening: BluetoothRemoteGATTCharacteristic | null = null;
  let alive = false;

  // move state (csTimer's module variables)
  let prevMoves: string[] = [];
  let timeOffs: number[] = [];
  let moveBuffer: Buffered[] = [];
  let prevCubie = new CubieCube();
  let curCubie = new CubieCube();
  let latestFacelet = SOLVED_FACELET;
  let deviceTime = 0;
  let deviceTimeOffset = 0;
  let moveCnt = -1;
  let prevMoveCnt = -1;
  let prevMoveLocTime: number | null = null;
  let movesFromLastCheck = 1000;
  let batteryLevel: number | null = null;
  let keyCheck = 0;

  const puzzle = () => (is251 ? '222' : '333');
  const name = (v2: boolean) => deviceName + (v2 ? '*' : '');

  function reset() {
    prevMoves = [];
    timeOffs = [];
    moveBuffer = [];
    prevCubie = new CubieCube();
    curCubie = new CubieCube();
    latestFacelet = SOLVED_FACELET;
    deviceTime = 0;
    deviceTimeOffset = 0;
    moveCnt = -1;
    prevMoveCnt = -1;
    prevMoveLocTime = null;
    movesFromLastCheck = 1000;
    batteryLevel = null;
    keyCheck = 0;
  }

  function applyMove(move: string, ts: [number | null, number | null], v2: boolean) {
    CubieCube.mult(prevCubie, MOVE_CUBE[moveIndex(move)], curCubie);
    ctx?.state(curCubie.toFaceCube(), prevMoves, ts, name(v2), puzzle());
    [curCubie, prevCubie] = [prevCubie, curCubie];
  }

  function initCubeState() {
    const loc = performance.now();
    ctx?.state(latestFacelet, [], [null, loc], deviceName, puzzle());
    prevCubie.fromFacelet(latestFacelet);
    prevMoveCnt = moveCnt;
    ctx?.connected(latestFacelet);
  }

  /** csTimer updateMoveTimes: moves since the last message, with device times rebuilt from the gaps */
  function updateMoveTimes(loc: number, v2: boolean) {
    let moveDiff = (moveCnt - prevMoveCnt) & 0xff;
    if (moveDiff > 1) ctx?.log('[gan] bluetooth events lost', moveDiff);
    prevMoveCnt = moveCnt;
    movesFromLastCheck += moveDiff;
    if (moveDiff > prevMoves.length) {
      movesFromLastCheck = 50;
      moveDiff = prevMoves.length;
    }
    let calcTs = deviceTime + deviceTimeOffset;
    for (let i = moveDiff - 1; i >= 0; i--) calcTs += timeOffs[i];
    if (!deviceTime || Math.abs(loc - calcTs) > 2000) deviceTime += loc - calcTs;
    for (let i = moveDiff - 1; i >= 0; i--) {
      CubieCube.mult(prevCubie, MOVE_CUBE[moveIndex(prevMoves[i])], curCubie);
      deviceTime += timeOffs[i];
      ctx?.state(curCubie.toFaceCube(), prevMoves.slice(i), [deviceTime, i === 0 ? loc : null], name(v2), puzzle());
      [curCubie, prevCubie] = [prevCubie, curCubie];
    }
    deviceTimeOffset = loc - deviceTime;
  }

  // ------------------------------------------------------------ gen1: read the cube in a loop
  async function checkState(): Promise<boolean | undefined> {
    if (movesFromLastCheck < 50) return false;
    const value = decode(aes, bytesOf(await chr.f2!.readValue()));
    const state: string[] = [];
    for (let i = 0; i < value.length - 2; i += 3) {
      const face = (value[i ^ 1] << 16) | (value[(i + 1) ^ 1] << 8) | value[(i + 2) ^ 1];
      for (let j = 21; j >= 0; j -= 3) {
        state.push('URFDLB'[(face >> j) & 0x7]);
        if (j === 12) state.push('URFDLB'[i / 3]);
      }
    }
    latestFacelet = state.join('');
    movesFromLastCheck = 0;
    if (prevMoveCnt === -1) {
      initCubeState();
      return undefined;
    }
    return true;
  }

  async function loopRead(): Promise<void> {
    while (alive) {
      const value = decode(aes, bytesOf(await chr.f5!.readValue()));
      const loc = performance.now();
      moveCnt = value[12];
      if (moveCnt === prevMoveCnt) continue;
      prevMoves = [];
      for (let i = 0; i < 6; i++) {
        const m = value[13 + i];
        prevMoves.unshift('URFDLB'[Math.floor(m / 3)] + " 2'"[m % 3]);
      }
      const f6 = decode(aes, bytesOf(await chr.f6!.readValue()));
      const updated = await checkState();
      if (updated) {
        if (prevCubie.toFaceCube() !== latestFacelet) ctx?.log('[gan] cube state check error');
        continue;
      }
      timeOffs = [];
      for (let i = 0; i < 9; i++) timeOffs.unshift(f6[i * 2 + 1] | (f6[i * 2 + 2] << 8));
      updateMoveTimes(loc, false);
    }
  }

  async function v1init(services: BluetoothRemoteGATTService[]) {
    const meta = findUUID(services, SERVICE_META)!;
    const data = findUUID(services, SERVICE_DATA)!;
    const v = bytesOf(await (await meta.getCharacteristic(CHR_VERSION)).readValue());
    const ver = (v[0] << 16) | (v[1] << 8) | v[2];
    aes = null;
    if (ver > 0x010007 && (ver & 0xfffe00) === 0x010000) {
      const hw = bytesOf(await (await meta.getCharacteristic(CHR_HARDWARE)).readValue());
      const key = GAN_KEYS[(ver >> 8) & 0xff];
      if (key) aes = new Aes128(key.map((k, i) => (i < 6 ? (k + hw[5 - i]) & 0xff : k)));
    }
    // csTimer warns about other versions but still reads them (the oldest firmware isn't encrypted)
    if (!aes) ctx?.log('[gan] gen1 version not known, reading it unencrypted', ver.toString(16));
    const chrs = await data.getCharacteristics();
    chr = { f2: findUUID(chrs, CHR_F2), f5: findUUID(chrs, CHR_F5), f6: findUUID(chrs, CHR_F6), f7: findUUID(chrs, CHR_F7) };
    alive = true;
    void loopRead().catch((e) => {
      if (alive) ctx?.log('[gan] read loop ended', e);
    });
  }

  // ------------------------------------------------------------ gen2+: the key
  async function initKey(ver: number, opts: { force?: boolean; wrong?: boolean } = {}) {
    keyVersion = ver;
    const mac = await ctx!.mac(deviceName, opts.force ? null : deviceMac, null, opts);
    if (!mac) {
      aes = null;
      throw new Error('the cube needs its MAC address to connect');
    }
    const m = macBytes(mac);
    aes = new Aes128(withMac(GAN_KEYS[2 + ver * 2], m));
    aes.iv = withMac(GAN_KEYS[3 + ver * 2], m);
  }

  /** data that won't decode means the key (the MAC) is wrong: ask for the MAC again */
  function badData() {
    keyCheck++;
    if (keyCheck === 3) {
      void initKey(keyVersion, { force: true, wrong: true })
        .then(() => {
          keyCheck = 0;
          return requestFacelets();
        })
        .catch(() => ctx?.lost());
    }
  }

  async function write(bytes: number[]) {
    const c = version === 2 ? chr.v2w : version === 3 ? chr.v3w : chr.v4w;
    if (!c) return;
    await c.writeValue(new Uint8Array(encode(aes, bytes)));
  }

  const simple2 = (op: number) => write([op, ...Array(19).fill(0)]);
  const simple3 = (op: number) => write([0x68, op, ...Array(14).fill(0)]);
  const v4req = (b0: number, b1: number, b3: number) => {
    const req = Array(20).fill(0);
    req[0] = b0;
    req[1] = b1;
    req[3] = b3;
    return write(req);
  };

  function requestFacelets() {
    if (version === 2) return simple2(4);
    if (version === 3) return simple3(1);
    return v4req(0xdd, 0x04, 0xed);
  }

  function requestMoveHistory(start: number, count: number) {
    // the history comes back byte-aligned from an odd move number: ask for an even count from one
    if (start % 2 === 0) start = (start - 1) & 0xff;
    if (count % 2 === 1) count++;
    // never across 255 -> 0: the firmware sends zeros ('D') past it
    count = Math.min(count, start + 1);
    let req: number[];
    if (version === 3) req = [0x68, 0x03, ...Array(14).fill(0)];
    else if (version === 4) req = [0xd1, 0x04, ...Array(18).fill(0)];
    else return;
    req[2] = start;
    req[3] = 0;
    req[4] = count;
    req[5] = 0;
    ctx?.log('[gan] asking for the move history', prevMoveCnt, start, count);
    void write(req).catch(() => undefined);
  }

  function decodeV4Move(pow: number, faceHot: number): string | null {
    let axis = [2, 32, 8, 1, 16, 4].indexOf(faceHot);
    if (axis === -1 && is251) {
      // the 251 UI sometimes sends the one-hot bits the other way round
      let rev = 0;
      for (let b = 0; b < 6; b++) if (faceHot & (1 << b)) rev |= 1 << (5 - b);
      axis = [2, 32, 8, 1, 16, 4].indexOf(rev);
    }
    if (axis === -1 || pow > 2) return null;
    return 'URFDLB'[axis] + (pow === 2 ? '2' : " '"[pow]);
  }

  function injectLostMove(move: Buffered) {
    if (moveBuffer.length > 0) {
      if (moveBuffer.some((e) => e[0] === move[0])) return;
      if (!inRange(prevMoveCnt, moveBuffer[0][0], move[0])) return;
      // lost moves come in reverse: only the one just before the head fits
      if (move[0] === ((moveBuffer[0][0] - 1) & 0xff)) moveBuffer.unshift(move);
    } else if (inRange(prevMoveCnt, moveCnt, move[0], false, true)) {
      moveBuffer.unshift(move);
    }
  }

  function evictMoveBuffer(requestLost: boolean) {
    while (moveBuffer.length > 0) {
      const diff = (moveBuffer[0][0] - prevMoveCnt) & 0xff;
      if (diff > 1) {
        if (is251) {
          // the history uses the 3x3 axes: skip the gap on the 251 rather than corrupt the state
          prevMoveCnt = (moveBuffer[0][0] - 1) & 0xff;
          continue;
        }
        if (requestLost) requestMoveHistory(moveBuffer[0][0], diff);
        break;
      }
      const move = moveBuffer.shift()!;
      prevMoves.unshift(move[1]);
      if (prevMoves.length > 8) prevMoves = prevMoves.slice(0, 8);
      applyMove(move[1], [move[2], move[3]], true);
      prevMoveCnt = move[0];
    }
    if (moveBuffer.length > 16) {
      ctx?.log('[gan] moves are not leaving the buffer: disconnecting');
      ctx?.lost();
    }
  }

  /** a facelets message while moves are under way: ask for the history when the cube is ahead */
  function stateAhead(loc: number) {
    if (prevMoveLocTime !== null && loc - prevMoveLocTime > 500) {
      const diff = (moveCnt - prevMoveCnt) & 0xff;
      // the firmware's facelets at move counter 0 can't be trusted to include move 0
      if (diff > 0 && moveCnt !== 0) requestMoveHistory(moveBuffer[0] ? moveBuffer[0][0] : (moveCnt + 1) & 0xff, diff + 1);
    }
  }

  function parseV2(raw: number[]) {
    const loc = performance.now();
    const v = bitString(decode(aes, raw));
    const mode = bits(v, 0, 4);
    if (mode === 2) {
      moveCnt = bits(v, 4, 12);
      if (moveCnt === prevMoveCnt || prevMoveCnt === -1) return;
      timeOffs = [];
      prevMoves = [];
      let invalid = false;
      for (let i = 0; i < 7; i++) {
        const m = bits(v, 12 + i * 5, 17 + i * 5);
        timeOffs[i] = bits(v, 47 + i * 16, 63 + i * 16);
        prevMoves[i] = 'URFDLB'[m >> 1] + " '"[m & 1];
        if (m >= 12) {
          prevMoves[i] = 'U ';
          invalid = true;
        }
      }
      if (invalid) badData();
      else updateMoveTimes(loc, true);
    } else if (mode === 4) {
      if (prevMoveCnt !== -1) return;
      moveCnt = bits(v, 4, 12);
      const cc = ganCubie(v, [12, 33], [47, 91]);
      if (!cc.verify()) return badData();
      latestFacelet = cc.toFaceCube();
      initCubeState();
    } else if (mode === 9) {
      batteryLevel = bits(v, 8, 16);
      ctx?.battery(batteryLevel, name(true));
    } else if (mode !== 1 && mode !== 5) {
      // not a message gen2 sends (1 is the gyro, 5 the hardware info): likely the key is wrong
      badData();
    }
  }

  function parseV3(raw: number[]) {
    const loc = performance.now();
    const v = bitString(decode(aes, raw));
    const magic = bits(v, 0, 8);
    const mode = bits(v, 8, 16);
    const len = bits(v, 16, 24);
    if (magic !== 0x55 || len <= 0) return badData();
    if (mode === 1) {
      prevMoveLocTime = loc;
      moveCnt = parseInt(v.slice(64, 72) + v.slice(56, 64), 2);
      if (moveCnt === prevMoveCnt || prevMoveCnt === -1) return;
      const ts = parseInt(v.slice(48, 56) + v.slice(40, 48) + v.slice(32, 40) + v.slice(24, 32), 2);
      const pow = bits(v, 72, 74);
      const axis = [2, 32, 8, 1, 16, 4].indexOf(bits(v, 74, 80));
      if (axis === -1) return badData();
      moveBuffer.push([moveCnt, 'URFDLB'[axis] + " '"[pow], ts, loc]);
      evictMoveBuffer(true);
    } else if (mode === 2) {
      moveCnt = parseInt(v.slice(32, 40) + v.slice(24, 32), 2);
      if (prevMoveCnt !== -1) return stateAhead(loc);
      const cc = ganCubie(v, [40, 61], [77, 121]);
      if (!cc.verify()) return badData();
      latestFacelet = cc.toFaceCube();
      initCubeState();
    } else if (mode === 6) {
      const start = bits(v, 24, 32);
      const n = (len - 1) * 2;
      for (let i = 0; i < n; i++) {
        const axis = bits(v, 32 + 4 * i, 35 + 4 * i);
        const pow = bits(v, 35 + 4 * i, 36 + 4 * i);
        if (axis < 6) injectLostMove([(start - i) & 0xff, 'DUBFLR'[axis] + " '"[pow], null, null]);
      }
      evictMoveBuffer(false);
    } else if (mode === 16) {
      batteryLevel = bits(v, 24, 32);
      ctx?.battery(batteryLevel, name(true));
    }
  }

  function parseV4(raw: number[]) {
    const loc = performance.now();
    const v = bitString(decode(aes, raw));
    const mode = bits(v, 0, 8);
    const len = bits(v, 8, 16);
    if (mode === 0x01) {
      prevMoveLocTime = loc;
      moveCnt = parseInt(v.slice(56, 64) + v.slice(48, 56), 2);
      if (moveCnt === prevMoveCnt || prevMoveCnt === -1) return;
      const ts = parseInt(v.slice(40, 48) + v.slice(32, 40) + v.slice(24, 32) + v.slice(16, 24), 2);
      let move = decodeV4Move(bits(v, 64, 66), bits(v, 66, 72));
      // the 251's other packing: face in 64..70, direction in 70..72
      if (!move && is251) move = decodeV4Move(bits(v, 70, 72), bits(v, 64, 70));
      if (!move) return badData();
      moveBuffer.push([moveCnt, move, ts, loc]);
      evictMoveBuffer(true);
    } else if (mode === 0xed) {
      moveCnt = parseInt(v.slice(24, 32) + v.slice(16, 24), 2);
      if (prevMoveCnt !== -1) return stateAhead(loc);
      const cc = ganCubie(v, [32, 53], [69, 113]);
      if (!cc.verify()) return badData();
      latestFacelet = cc.toFaceCube();
      initCubeState();
    } else if (mode === 0xd1) {
      const start = bits(v, 16, 24);
      const n = (len - 1) * 2;
      for (let i = 0; i < n; i++) {
        const axis = bits(v, 24 + 4 * i, 27 + 4 * i);
        const pow = bits(v, 27 + 4 * i, 28 + 4 * i);
        if (axis < 6) injectLostMove([(start - i) & 0xff, 'DUBFLR'[axis] + " '"[pow], null, null]);
      }
      evictMoveBuffer(false);
    } else if (mode === 0xef) {
      batteryLevel = bits(v, 8 + len * 8, 16 + len * 8);
      ctx?.battery(batteryLevel, name(true));
    } else if (![0xec, 0xf5, 0xf6, 0xfa, 0xfc, 0xfd, 0xfe, 0xff].includes(mode)) {
      // not a message gen4 sends (0xEC is the gyro, 0xF5-0xFF hardware info): likely the key is wrong
      badData();
    }
  }

  const onNotify = (e: Event) => {
    if (!aes) return;
    const raw = bytesOf((e.target as BluetoothRemoteGATTCharacteristic).value!);
    if (version === 2) parseV2(raw);
    else if (version === 3) parseV3(raw);
    else parseV4(raw);
  };

  async function listen(read: BluetoothRemoteGATTCharacteristic | null) {
    if (!read) throw new Error("this GAN cube doesn't answer the way cubr expects");
    listening = read;
    read.addEventListener('characteristicvaluechanged', onNotify);
    await read.startNotifications();
  }

  return {
    prefix: ['GAN', 'MG', 'AiCube'],
    services: [SERVICE_DATA, SERVICE_META, SERVICE_V2, SERVICE_V3, SERVICE_V4],
    cics: GAN_CICS,
    debug: { parseV2, parseV3, parseV4, state: () => ({ prevMoveCnt, moveCnt, moveBuffer, facelet: prevCubie.toFaceCube() }) },
    async init(dev, c, g) {
      await this.clear(false);
      ctx = c;
      group = g;
      device = dev;
      reset();
      deviceName = dev.name ?? 'GAN';
      is251 = /^(GAN251Ui|GAN251UI|gan251ui|GANic251|ganic251)/i.test(deviceName);
      deviceMac = null;
      try {
        const view = manufacturerBytes(await g.waitForAdvertisement(), GAN_CICS, [2, 11]);
        if (view && view.byteLength >= 6) {
          // the first 9 bytes; the MAC is the last six of them, the other way round
          const nine = new DataView(view.buffer.slice(view.byteOffset, view.byteOffset + Math.min(9, view.byteLength)));
          deviceMac = Array.from({ length: 6 }, (_, i) => nine.getUint8(nine.byteLength - i - 1).toString(16).padStart(2, '0')).join(':');
        }
      } catch {
        /* no advertisements: saved or asked for */
      }
      const gatt = await dev.gatt!.connect();
      const services = await gatt.getPrimaryServices();
      const v2 = findUUID(services, SERVICE_V2);
      const v3 = findUUID(services, SERVICE_V3);
      const v4 = findUUID(services, SERVICE_V4);
      if (v2) {
        version = 2;
        await initKey(deviceName.startsWith('AiCube') ? 1 : 0);
        const chrs = await v2.getCharacteristics();
        chr = { v2r: findUUID(chrs, CHR_V2_READ), v2w: findUUID(chrs, CHR_V2_WRITE) };
        await listen(chr.v2r);
        await simple2(5);
        await simple2(4);
        await simple2(9);
      } else if (v3) {
        version = 3;
        await initKey(0);
        const chrs = await v3.getCharacteristics();
        chr = { v3r: findUUID(chrs, CHR_V3_READ), v3w: findUUID(chrs, CHR_V3_WRITE) };
        await listen(chr.v3r);
        await simple3(4);
        await simple3(1);
        await simple3(7);
      } else if (v4) {
        version = 4;
        await initKey(is251 ? 2 : 0);
        const chrs = await v4.getCharacteristics();
        chr = { v4r: findUUID(chrs, CHR_V4_READ), v4w: findUUID(chrs, CHR_V4_WRITE) };
        await listen(chr.v4r);
        await write([0xdf, 0x03, ...Array(18).fill(0)]);
        await v4req(0xdd, 0x04, 0xed);
        await v4req(0xdd, 0x04, 0xef);
      } else if (findUUID(services, SERVICE_META) && findUUID(services, SERVICE_DATA)) {
        version = 1;
        await v1init(services);
      } else {
        throw new Error("this GAN cube isn't one cubr knows");
      }
      void group;
      void device;
    },
    async battery() {
      if (version === 1 && chr.f7) {
        const v = decode(aes, bytesOf(await chr.f7.readValue()));
        return v[7];
      }
      return batteryLevel;
    },
    async clear() {
      alive = false;
      if (listening) {
        listening.removeEventListener('characteristicvaluechanged', onNotify);
        await listening.stopNotifications().catch(() => undefined);
        listening = null;
      }
      chr = {};
      aes = null;
      reset();
    },
  };
}
