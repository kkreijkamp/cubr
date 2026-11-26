import { describe, expect, it } from 'vitest';
import { Aes128 } from '../bluetooth/aes128';
import { BtTimerState } from '../bluetooth/btTimer';
import { crc16ccitt } from '../bluetooth/crc';
import { QIYI_TIMER_KEY } from '../bluetooth/keys';
import { ganTimerEvent, ganTimerValid, qiyiTimerHello, qiyiTimerPackets, QiyiTimerReader, TimerEvent } from '../bluetooth/timers';

/** a GAN timer notification: FE, a length byte, the state, (the time), CRC-16/CCITT little endian */
function gan(state: number, time?: [number, number, number]): number[] {
  const body = [0xfe, 0x00, 0x01, state];
  if (time) body.push(time[0], time[1], time[2] & 0xff, time[2] >> 8);
  const crc = crc16ccitt(body.slice(2));
  return [...body, crc & 0xff, crc >> 8];
}

describe('GAN smart timer', () => {
  it('reads its states and the stopped time', () => {
    expect(ganTimerEvent(gan(6)).state).toBe(TimerEvent.HANDS_ON);
    expect(ganTimerEvent(gan(1)).state).toBe(TimerEvent.GET_SET);
    expect(ganTimerEvent(gan(3)).state).toBe(TimerEvent.RUNNING);
    expect(ganTimerEvent(gan(5)).state).toBe(TimerEvent.GAN_RESET);
    // 1:02.345
    expect(ganTimerEvent(gan(4, [1, 2, 345]))).toEqual({ state: TimerEvent.STOPPED, solveTime: 62345 });
  });

  it('checks the magic byte and the checksum', () => {
    expect(ganTimerValid(gan(4, [0, 9, 87]))).toBe(true);
    const bad = gan(4, [0, 9, 87]);
    bad[5] ^= 1;
    expect(ganTimerValid(bad)).toBe(false);
    expect(ganTimerValid([0x00, ...gan(1).slice(1)])).toBe(false);
  });
});

describe('QiYi smart timer', () => {
  const aes = new Aes128(QIYI_TIMER_KEY);
  /** what the timer would send: a 0x1003 message with a data point */
  const fromTimer = (dp: number[]) => qiyiTimerPackets(aes, 7, 3, 0x1003, dp);

  it('reads a recorded time across several packets and asks for an ack', () => {
    // dpId 1 type 1: [id, type, len hi, len lo, ..., solve time (4, big endian) at 8, inspection at 12]
    const dp = [1, 1, 0, 12, 0, 0, 0, 0, 0, 0, 0x30, 0x39, 0, 0, 0x1f, 0x40];
    const packets = fromTimer(dp);
    expect(packets.length).toBeGreaterThan(1);
    const reader = new QiyiTimerReader(new Aes128(QIYI_TIMER_KEY));
    const results = packets.map((p) => reader.read(p));
    expect(results.slice(0, -1).every((r) => r === null)).toBe(true);
    expect(results.at(-1)).toEqual({ event: { state: TimerEvent.STOPPED, solveTime: 12345, inspectTime: 8000 }, ack: { sendSN: 4, ackSN: 7, cmd: 0x1003 } });
  });

  it('reads its state', () => {
    const reader = new QiyiTimerReader(new Aes128(QIYI_TIMER_KEY));
    // dpId 4 type 4: state index 3 (running), time 1500
    const packets = fromTimer([4, 4, 0, 5, 3, 0, 0, 0x05, 0xdc]);
    let r = null;
    for (const p of packets) r = reader.read(p);
    expect(r).toEqual({ event: { state: TimerEvent.RUNNING, solveTime: 1500 } });
  });

  it('drops a message whose checksum is off', () => {
    const reader = new QiyiTimerReader(new Aes128(QIYI_TIMER_KEY));
    const packets = fromTimer([4, 4, 0, 5, 3, 0, 0, 0x05, 0xdc]);
    // flip a byte inside the encrypted block: it decrypts to garbage
    packets[0][6] ^= 0xff;
    let r = null;
    for (const p of packets) r = reader.read(p);
    expect(r).toBeNull();
  });

  it('says hello with its MAC reversed', () => {
    expect(qiyiTimerHello('CC:A1:00:00:12:34').slice(-6)).toEqual([0x34, 0x12, 0x00, 0x00, 0xa1, 0xcc]);
  });
});

describe('bluetooth timer timing (csTimer timer/bttimer.js)', () => {
  it('follows a solve and records the timer time', () => {
    const t = new BtTimerState();
    t.connected = true;
    t.handle({ state: TimerEvent.HANDS_ON }, 0);
    expect(t.light).toBe('red');
    t.handle({ state: TimerEvent.GET_SET }, 500);
    expect(t.light).toBe('green');
    t.handle({ state: TimerEvent.RUNNING, solveTime: 0 }, 1000);
    expect(t.phase).toBe('running');
    expect(t.handle({ state: TimerEvent.STOPPED, solveTime: 8765 }, 9800)).toEqual({ timeMs: 8765, penalty: 'OK' });
    // the same stop again (QiYi's two stop messages) is not a second solve
    expect(t.handle({ state: TimerEvent.STOPPED, solveTime: 8765 }, 9900)).toBeNull();
    t.handle({ state: TimerEvent.GAN_RESET }, 12000);
    expect(t.hardTime).toBe(0);
  });

  it('inspection from the reset button or space, with penalties', () => {
    const t = new BtTimerState();
    t.connected = true;
    t.inspection = true;
    t.handle({ state: TimerEvent.GAN_RESET }, 0);
    expect(t.phase).toBe('inspecting');
    t.handle({ state: TimerEvent.RUNNING, solveTime: 0 }, 16_000);
    expect(t.handle({ state: TimerEvent.STOPPED, solveTime: 5000 }, 21_000)?.penalty).toBe('+2');

    t.handle({ state: TimerEvent.GAN_RESET }, 30_000);
    expect(t.phase).toBe('idle');
    expect(t.spaceDown(31_000)).toBe(true);
    expect(t.spaceUp(31_100)).toBe(true);
    t.handle({ state: TimerEvent.RUNNING, solveTime: 0 }, 31_100 + 17_500);
    expect(t.handle({ state: TimerEvent.STOPPED, solveTime: 4000 }, 60_000)?.penalty).toBe('DNF');
  });

  it('a disconnect leaves it idle with no time', () => {
    const t = new BtTimerState();
    t.connected = true;
    t.handle({ state: TimerEvent.RUNNING, solveTime: 100 }, 0);
    t.handle({ state: TimerEvent.DISCONNECT }, 10);
    expect(t).toMatchObject({ phase: 'idle', hardTime: null, connected: false });
  });
});

import { FakeCharacteristic, FakeDevice, FakeService, tick } from './fakeBluetooth';
import { timerGroup, type TimerEventData } from '../bluetooth/timers';

describe('bluetooth timers, connected (fake devices)', () => {
  const ctxFor = (events: TimerEventData[], macs: string[] = []) => ({
    event: (e: TimerEventData) => events.push(e),
    mac: async (_n: string, found: string | null, suggested: string | null) => {
      macs.push(found ?? suggested ?? '');
      return found ?? suggested;
    },
    log: () => undefined,
  });

  it('GAN: finds the timer by name and passes its notifications on', async () => {
    const state = new FakeCharacteristic('0000fff5-0000-1000-8000-00805f9b34fb');
    const device = new FakeDevice('GAN-ab12', [new FakeService('0000fff0-0000-1000-8000-00805f9b34fb', [state])]);
    const events: TimerEventData[] = [];
    const group = timerGroup();
    expect(await group.setUp(device as never, ctxFor(events))).toBe('GAN-ab12');
    state.notify(gan(6));
    state.notify(gan(3));
    state.notify(gan(4, [0, 7, 891]));
    expect(events.map((e) => e.state)).toEqual([TimerEvent.HANDS_ON, TimerEvent.RUNNING, TimerEvent.STOPPED]);
    expect(events[2].solveTime).toBe(7891);
    // switched off: a disconnect event, and the page hears about it
    let gone = false;
    group.onDisconnect = () => (gone = true);
    device.drop();
    await tick();
    expect(gone).toBe(true);
    expect(events.at(-1)?.state).toBe(TimerEvent.DISCONNECT);
  });

  it('GAN: a timer with no name is found by its service', async () => {
    const state = new FakeCharacteristic('0000fff5-0000-1000-8000-00805f9b34fb');
    const device = new FakeDevice('', [new FakeService('0000fff0-0000-1000-8000-00805f9b34fb', [state])]);
    const events: TimerEventData[] = [];
    await timerGroup().setUp(device as never, ctxFor(events));
    state.notify(gan(1));
    expect(events[0].state).toBe(TimerEvent.GET_SET);
  });

  it('QiYi: reads the MAC from the advertisement, says hello with it, acks recorded times', async () => {
    const write = new FakeCharacteristic('00000001-0000-1001-8001-00805f9b07d0');
    const read = new FakeCharacteristic('00000002-0000-1001-8001-00805f9b07d0');
    // manufacturer data under 0x0504: the MAC, lowest byte first
    const mfd = new Map([[0x0504, new DataView(new Uint8Array([0x34, 0x12, 0x00, 0x00, 0xa1, 0xcc]).buffer)]]);
    const device = new FakeDevice('QY-Timer-1234', [new FakeService('0000fd50-0000-1000-8000-00805f9b34fb', [write, read])], mfd);
    const events: TimerEventData[] = [];
    const macs: string[] = [];
    await timerGroup().setUp(device as never, ctxFor(events, macs));
    expect(macs).toEqual(['cc:a1:00:00:12:34']);
    // the hello went out: decrypt the first packet and find the MAC (reversed) in it
    const aes = new Aes128(QIYI_TIMER_KEY);
    const first = write.writes[0].slice(4);
    aes.decrypt(first);
    expect(first.slice(0, 12)).toEqual([0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 17]);
    // the timer records a time
    for (const p of qiyiTimerPackets(aes, 9, 1, 0x1003, [1, 1, 0, 12, 0, 0, 0, 0, 0, 0, 0x10, 0x00, 0, 0, 0, 0])) read.notify(p);
    expect(events).toEqual([{ state: TimerEvent.STOPPED, solveTime: 4096, inspectTime: 0 }]);
    await tick();
    // and its ack went back: sendSN = ackSN + 1, ackSN = the timer's sendSN
    const ack = write.writes.at(-1)!.slice(4);
    aes.decrypt(ack);
    expect(ack.slice(0, 10)).toEqual([0, 0, 0, 2, 0, 0, 0, 9, 0x10, 0x03]);
  });

  it('QiYi: without advertisements, the MAC its name suggests', async () => {
    const write = new FakeCharacteristic('00000001-0000-1001-8001-00805f9b07d0');
    const read = new FakeCharacteristic('00000002-0000-1001-8001-00805f9b07d0');
    const device = new FakeDevice('QY-Adapter-ABCD', [new FakeService('0000fd50-0000-1000-8000-00805f9b34fb', [write, read])]);
    const macs: string[] = [];
    await timerGroup().setUp(device as never, ctxFor([], macs));
    expect(macs).toEqual(['CC:A8:00:00:AB:CD']);
  });
});
