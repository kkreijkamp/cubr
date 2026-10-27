// Bluetooth smart timers: GAN Smart Timer (csTimer hardware/gantimer.js) and QiYi Smart Timer
// (hardware/qiyitimer.js). Each turns its notifications into timer events.
import { Aes128 } from './aes128';
import { crc16ccitt, crc16modbus } from './crc';
import { bytesOf, BtGroup, findUUID, type BtModel } from './device';
import { macBytes, QIYI_TIMER_KEY } from './keys';

/** csTimer's BluetoothTimer.CONST */
export const TimerEvent = {
  DISCONNECT: 0,
  GET_SET: 1,
  HANDS_OFF: 2,
  RUNNING: 3,
  STOPPED: 4,
  IDLE: 5,
  HANDS_ON: 6,
  FINISHED: 7,
  INSPECTION: 8,
  GAN_RESET: 9,
} as const;

export interface TimerEventData {
  state: number;
  solveTime?: number;
  inspectTime?: number;
}

export interface TimerCtx {
  event(e: TimerEventData): void;
  /** the timer's MAC address (QiYi), from its advertisement or asked for */
  mac(name: string, found: string | null, suggested: string | null): Promise<string | null>;
  log(...args: unknown[]): void;
}

// ---------------------------------------------------------------- GAN
const GAN_SERVICE = '0000fff0-0000-1000-8000-00805f9b34fb';
const GAN_STATE = '0000fff5-0000-1000-8000-00805f9b34fb';

const GAN_STATES = [TimerEvent.DISCONNECT, TimerEvent.GET_SET, TimerEvent.HANDS_OFF, TimerEvent.RUNNING, TimerEvent.STOPPED, TimerEvent.GAN_RESET, TimerEvent.HANDS_ON, TimerEvent.FINISHED];

/** a GAN timer notification as an event (also used by the tests) */
export function ganTimerEvent(data: number[]): TimerEventData {
  const state = GAN_STATES[data[3]] ?? 0;
  const e: TimerEventData = { state };
  if (state === TimerEvent.STOPPED) e.solveTime = 60000 * data[4] + 1000 * data[5] + (data[6] | (data[7] << 8));
  return e;
}

/** magic 0xFE, then a CRC-16/CCITT of everything from byte 2 up to the CRC (little endian at the end) */
export function ganTimerValid(data: number[]): boolean {
  if (data.length < 4 || data[0] !== 0xfe) return false;
  const crc = data[data.length - 2] | (data[data.length - 1] << 8);
  return crc === crc16ccitt(data.slice(2, data.length - 2));
}

function ganTimer(): BtModel<TimerCtx> {
  let chr: BluetoothRemoteGATTCharacteristic | null = null;
  let ctx: TimerCtx | null = null;
  const onRead = (e: Event) => {
    const data = bytesOf((e.target as BluetoothRemoteGATTCharacteristic).value!);
    // csTimer passes on an event even when its checksum is off (it only logs it)
    if (!ganTimerValid(data)) ctx?.log('[gan timer] invalid event', data);
    ctx?.event(ganTimerEvent(data));
  };
  return {
    prefix: ['GAN', 'Gan', 'gan'],
    services: [GAN_SERVICE],
    serviceFilters: [GAN_SERVICE],
    async init(device, c) {
      ctx = c;
      const gatt = await device.gatt!.connect();
      const service = await gatt.getPrimaryService(GAN_SERVICE);
      chr = await service.getCharacteristic(GAN_STATE);
      chr.addEventListener('characteristicvaluechanged', onRead);
      await chr.startNotifications();
    },
    async clear(hardware) {
      if (!chr) return;
      chr.removeEventListener('characteristicvaluechanged', onRead);
      await chr.stopNotifications().catch(() => undefined);
      chr = null;
      if (hardware) ctx?.event({ state: TimerEvent.DISCONNECT });
    },
  };
}

// ---------------------------------------------------------------- QiYi
const QY_SERVICE = '0000fd50-0000-1000-8000-00805f9b34fb';
const QY_SUFFIX = '-0000-1001-8001-00805f9b07d0';
const QY_WRITE = `00000001${QY_SUFFIX}`;
const QY_READ = `00000002${QY_SUFFIX}`;
const QY_CICS = [0x0504];

/**
 * QiYi messages: [sendSN 4][ackSN 4][cmd 2][len 2][data][crc 2], in 16-byte AES blocks (padded with 1s);
 * the first packet starts [0, length + 2, 0x40, 0], later ones with their block number.
 */
export function qiyiTimerPackets(aes: Aes128, sendSN: number, ackSN: number, cmd: number, data: number[]): number[][] {
  let msg = [(sendSN >> 24) & 0xff, (sendSN >> 16) & 0xff, (sendSN >> 8) & 0xff, sendSN & 0xff, (ackSN >> 24) & 0xff, (ackSN >> 16) & 0xff, (ackSN >> 8) & 0xff, ackSN & 0xff, (cmd >> 8) & 0xff, cmd & 0xff, (data.length >> 8) & 0xff, data.length & 0xff];
  msg = msg.concat(data);
  const crc = crc16modbus(msg);
  msg.push(crc >> 8, crc & 0xff);
  const out: number[][] = [];
  for (let i = 0; i < msg.length; i += 16) {
    const block = msg.slice(i, i + 16);
    while (block.length < 16) block.push(1);
    aes.encrypt(block);
    out.push((i === 0 ? [0x00, msg.length + 2, 0x40, 0x00] : [i >> 4]).concat(block));
  }
  return out;
}

/** reassembles and decrypts QiYi timer notifications into events (and the acks to send back) */
export class QiyiTimerReader {
  private waitPkg = 0;
  private payloadLen = 0;
  private payload: number[] = [];
  constructor(private readonly aes: Aes128) {}

  /** one notification; returns an event and, for a recorded time, the ack to send */
  read(raw: number[]): { event?: TimerEventData; ack?: { sendSN: number; ackSN: number; cmd: number } } | null {
    let msg = raw.slice();
    if (msg[0] !== this.waitPkg) {
      this.waitPkg = 0;
      this.payload = [];
      if (msg[0] !== 0) return null;
    }
    if (msg[0] === 0) {
      this.payloadLen = msg[1] - 2;
      msg = msg.slice(4);
    } else {
      msg = msg.slice(1);
    }
    for (let i = 0; i < msg.length; i += 16) {
      const block = msg.slice(i, i + 16);
      if (block.length < 16) {
        this.waitPkg = 0;
        this.payload = [];
        return null;
      }
      this.aes.decrypt(block);
      this.payload = this.payload.concat(block);
    }
    if (this.payload.length < this.payloadLen) {
      this.waitPkg++;
      return null;
    }
    let data = this.payload.slice(0, this.payloadLen);
    this.waitPkg = 0;
    this.payload = [];
    const len = (data[10] << 8) | data[11];
    if (crc16modbus(data.slice(0, len + 12).concat([data[len + 13], data[len + 12]])) !== 0) return null;
    const sendSN = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0;
    const ackSN = ((data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7]) >>> 0;
    const cmd = (data[8] << 8) | data[9];
    data = data.slice(12, len + 12);
    if (cmd !== 0x1003) return null;
    const dpId = data[0];
    const dpType = data[1];
    if (dpId === 1 && dpType === 1) {
      // a recorded time
      const solveTime = ((data[8] << 24) | (data[9] << 16) | (data[10] << 8) | data[11]) >>> 0;
      const inspectTime = ((data[12] << 24) | (data[13] << 16) | (data[14] << 8) | data[15]) >>> 0;
      return { event: { state: TimerEvent.STOPPED, solveTime, inspectTime }, ack: { sendSN: ackSN + 1, ackSN: sendSN, cmd: 0x1003 } };
    }
    if (dpId === 4 && dpType === 4) {
      const state = [TimerEvent.IDLE, TimerEvent.INSPECTION, TimerEvent.GET_SET, TimerEvent.RUNNING, TimerEvent.FINISHED, TimerEvent.STOPPED, TimerEvent.DISCONNECT][data[4]];
      const solveTime = ((data[5] << 24) | (data[6] << 16) | (data[7] << 8) | data[8]) >>> 0;
      return state === undefined ? null : { event: { state, solveTime } };
    }
    return null;
  }
}

/** the hello message: fixed bytes, then the MAC reversed */
export function qiyiTimerHello(mac: string): number[] {
  return [0, 0, 0, 0, 0, 33, 8, 0, 1, 5, 90, ...macBytes(mac).reverse()];
}

function manufacturerBytes(data: Map<number, DataView> | DataView, cics: number[]): DataView | null {
  // Bluefy hands over the raw bytes, company id first
  if (data instanceof DataView) return new DataView(data.buffer.slice(2));
  for (const id of cics) if (data.has(id)) return data.get(id)!;
  return null;
}

function qiyiTimer(): BtModel<TimerCtx> {
  let read: BluetoothRemoteGATTCharacteristic | null = null;
  let write: BluetoothRemoteGATTCharacteristic | null = null;
  let ctx: TimerCtx | null = null;
  const aes = new Aes128(QIYI_TIMER_KEY);
  let reader = new QiyiTimerReader(aes);
  const send = async (sendSN: number, ackSN: number, cmd: number, data: number[]) => {
    for (const p of qiyiTimerPackets(aes, sendSN, ackSN, cmd, data)) await write?.writeValue(new Uint8Array(p));
  };
  const onRead = (e: Event) => {
    const r = reader.read(bytesOf((e.target as BluetoothRemoteGATTCharacteristic).value!));
    if (!r) return;
    if (r.event) ctx?.event(r.event);
    if (r.ack) void send(r.ack.sendSN, r.ack.ackSN, r.ack.cmd, [0x00]).catch(() => undefined);
  };
  return {
    prefix: ['QY-Timer', 'QY-Adapter'],
    services: [QY_SERVICE],
    cics: QY_CICS,
    async init(device, c, group) {
      ctx = c;
      reader = new QiyiTimerReader(aes);
      const name = (device.name ?? '').trim();
      let found: string | null = null;
      try {
        const view = manufacturerBytes(await group.waitForAdvertisement(), QY_CICS);
        if (view && view.byteLength >= 6) found = Array.from({ length: 6 }, (_, i) => view.getUint8(5 - i).toString(16).padStart(2, '0')).join(':');
      } catch {
        /* no advertisements: ask for it */
      }
      const gatt = await device.gatt!.connect();
      const service = await gatt.getPrimaryService(QY_SERVICE);
      const chrs = await service.getCharacteristics();
      write = findUUID(chrs, QY_WRITE);
      read = findUUID(chrs, QY_READ);
      if (!read || !write) throw new Error("this QiYi timer doesn't answer the way cubetype expects");
      read.addEventListener('characteristicvaluechanged', onRead);
      await read.startNotifications();
      const m = /^QY-(?:Timer|Adapter).*-([0-9A-F]{4})$/.exec(name);
      const suggested = m ? `${name.startsWith('QY-Adapter') ? 'CC:A8' : 'CC:A1'}:00:00:${m[1].slice(0, 2)}:${m[1].slice(2, 4)}` : null;
      const mac = await c.mac(name, found, suggested);
      if (!mac) throw new Error('the timer needs its MAC address to connect');
      await send(1, 0, 1, qiyiTimerHello(mac));
    },
    async clear(hardware) {
      if (!read) return;
      read.removeEventListener('characteristicvaluechanged', onRead);
      await read.stopNotifications().catch(() => undefined);
      read = null;
      write = null;
      if (hardware) ctx?.event({ state: TimerEvent.DISCONNECT });
    },
  };
}

export const timerGroup = () => new BtGroup<TimerCtx>([ganTimer(), qiyiTimer()]);
