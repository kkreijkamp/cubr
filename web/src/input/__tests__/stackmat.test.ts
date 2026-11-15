import { describe, expect, it } from 'vitest';
import { StackmatDecoder, type StackmatState } from '../stackmat/decoder';

const RATE = 44100;

/** a little audio: each "level" (0/1) held for `bits` bit times, with soft edges and a bit of noise */
class Signal {
  samples: number[] = [];
  private t = 0;
  private last = 0;
  constructor(
    private readonly bitLen: number,
    private readonly amp = 0.3,
    private readonly invert = false,
  ) {}
  /** a couple of seconds of the line at rest: the automatic gain settles (a real timer sends all the time) */
  settle(v: number) {
    return this.level(v, (2 * RATE) / this.bitLen);
  }
  level(v: number, bits = 1) {
    const end = this.t + bits * this.bitLen;
    const target = ((v ^ (this.invert ? 1 : 0)) ? 1 : -1) * this.amp;
    while (this.samples.length < Math.round(end)) {
      // a fast edge, like a real line, and noise
      this.last += (target - this.last) * 0.9;
      this.samples.push(this.last + (Math.random() - 0.5) * 0.02);
    }
    this.t = end;
    return this;
  }
}

/** a stackmat packet: status letter, digits, checksum, newline, carriage return, as 8N1 frames (mark = idle = 1) */
function stackmat(sig: Signal, head: string, digits: string) {
  const sum = 64 + [...digits].reduce((s, d) => s + Number(d), 0);
  const bytes = [head, ...digits, String.fromCharCode(sum), '\n', '\r'].map((c) => c.charCodeAt(0));
  for (const b of bytes) {
    sig.level(0); // start bit
    for (let i = 0; i < 8; i++) sig.level((b >> i) & 1);
    sig.level(1); // stop bit
  }
  sig.level(1, 30); // idle between packets
}

/** the line at rest, then a packet that gets it in step (a plugged-in timer is always sending): csTimer's
 *  edge detector starts out expecting a rising edge, so the very first packet on a line idling high is lost */
function warm(sig: Signal) {
  sig.settle(1);
  stackmat(sig, 'S', '00000');
  return sig;
}

function decode(samples: number[], kind: 'stackmat' | 'moyu' = 'stackmat') {
  const states: StackmatState[] = [];
  const d = new StackmatDecoder(RATE, kind, (s) => states.push(s));
  // in chunks, as the audio callback hands them over
  for (let i = 0; i < samples.length; i += 1024) d.process(samples.slice(i, i + 1024));
  return states;
}

describe('stackmat signal', () => {
  for (const invert of [false, true]) {
    it(`reads a solve from the packets (${invert ? 'inverted' : 'normal'} polarity)`, () => {
      const sig = warm(new Signal(RATE / 1200, 0.3, invert));
      stackmat(sig, 'I', '00000');
      stackmat(sig, 'C', '00000');
      stackmat(sig, 'A', '00000');
      stackmat(sig, ' ', '00012');
      stackmat(sig, ' ', '00025');
      stackmat(sig, ' ', '01233');
      stackmat(sig, 'S', '01234');
      stackmat(sig, 'S', '01234');
      const got = decode(sig.samples).filter((s) => s.on);
      const heads = got.map((s) => s.signalHeader).join('');
      expect(heads).toContain('ICA');
      const running = got.filter((s) => s.running).map((s) => s.time_milli);
      expect(running).toEqual(expect.arrayContaining([120, 250, 12330]));
      const last = got[got.length - 1];
      expect(last).toMatchObject({ signalHeader: 'S', time_milli: 12340, running: false, unit: 10 });
      // both hands down shows on the hands, the green light on 'A'
      expect(got.find((s) => s.signalHeader === 'C')).toMatchObject({ leftHand: true, rightHand: true, greenLight: false });
      expect(got.find((s) => s.signalHeader === 'A')).toMatchObject({ greenLight: true });
    });
  }

  it('reads six-digit (millisecond) timers', () => {
    const sig = warm(new Signal(RATE / 1200));
    stackmat(sig, 'S', '012345');
    const got = decode(sig.samples).filter((s) => s.on);
    expect(got[got.length - 1]).toMatchObject({ time_milli: 12345, unit: 1 });
  });

  it('drops a packet with a bad checksum', () => {
    const sig = warm(new Signal(RATE / 1200));
    const bytes = ['S', '0', '1', '2', '3', '4', 'X', '\n', '\r'].map((c) => c.charCodeAt(0));
    for (const b of bytes) {
      sig.level(0);
      for (let i = 0; i < 8; i++) sig.level((b >> i) & 1);
      sig.level(1);
    }
    sig.level(1, 30);
    expect(decode(sig.samples).filter((s) => s.on)).toHaveLength(0);
  });

  it('notices when the signal stops', () => {
    const sig = warm(new Signal(RATE / 1200));
    stackmat(sig, 'S', '01234');
    sig.level(1, 400);
    const got = decode(sig.samples);
    expect(got.some((s) => s.on)).toBe(true);
    expect(got[got.length - 1].on).toBe(false);
  });

  it('without the status letter, running is the time going up', () => {
    const sig = warm(new Signal(RATE / 1200));
    for (const t of ['00000', '00000', '00012', '00025', '00025']) stackmat(sig, 'C', t);
    const states: StackmatState[] = [];
    const d = new StackmatDecoder(RATE, 'stackmat', (s) => states.push(s));
    d.useStatus = false;
    d.process(sig.samples);
    const on = states.filter((s) => s.on).slice(-5);
    expect(on.map((s) => s.running)).toEqual([false, false, true, true, false]);
  });
});

describe('moyu timer signal', () => {
  /** six BCD digits, low digit first, four bits each low bit first; each bit after a one-bit marker */
  function moyu(sig: Signal, ms: number, idle: number) {
    const digits = String(ms).padStart(6, '0').split('').reverse().map(Number);
    const n = 1 - idle;
    for (const d of digits) {
      for (let j = 0; j < 4; j++) {
        const bit = (d >> j) & 1;
        sig.level(n);
        if (bit === n) sig.level(n).level(idle);
        else sig.level(idle);
      }
    }
    sig.level(idle, 40);
  }

  it.each([0, 1])('reads the time (idle level %d)', (idle) => {
    const sig = new Signal(RATE / 8000).settle(idle);
    for (const t of [0, 0, 5, 1234, 65432]) moyu(sig, t, idle);
    const got = decode(sig.samples, 'moyu').filter((s) => s.on).slice(-4);
    expect(got.map((s) => s.time_milli)).toEqual([0, 5, 1234, 65432]);
    // the time going up is running
    expect(got.map((s) => s.running)).toEqual([false, true, true, true]);
  });
});

import { StackmatTimer } from '../stackmat/timer';

describe('stackmat timing (csTimer timer/stackmat.js)', () => {
  const st = (head: string, ms: number, running: boolean, on = true): StackmatState => ({
    on,
    time_milli: ms,
    unit: 10,
    greenLight: head === 'A',
    leftHand: 'LAC'.includes(head),
    rightHand: 'RAC'.includes(head),
    running,
    signalHeader: head,
    unknownRunning: false,
    noise: 0,
    power: 1,
  });

  it('records the time the timer stopped at', () => {
    const t = new StackmatTimer();
    expect(t.update(st('I', 0, false), 0)).toBeNull();
    t.update(st('C', 0, false), 100);
    t.update(st('A', 0, false), 600);
    t.update(st(' ', 120, true), 1000);
    expect(t.phase).toBe('running');
    expect(t.startTime).toBe(880);
    t.update(st(' ', 9870, true), 10750);
    expect(t.update(st('S', 9876, false), 10800)).toEqual({ timeMs: 9876, penalty: 'OK' });
    expect(t.phase).toBe('idle');
    // the same stopped time again is not another solve
    expect(t.update(st('S', 9876, false), 10900)).toBeNull();
  });

  it('inspection: started with space or a hand on the mat, penalties from when the timer started', () => {
    const t = new StackmatTimer();
    t.inspection = true;
    t.update(st('I', 0, false), 0);
    expect(t.spaceDown(1000)).toBe(true);
    expect(t.phase).toBe('inspect-ready');
    t.spaceUp(1100);
    expect(t.phase).toBe('inspecting');
    // started 16 s into inspection: +2
    t.update(st(' ', 50, true), 1100 + 16_050);
    const r = t.update(st('S', 5000, false), 1100 + 21_000);
    expect(r).toEqual({ timeMs: 5000, penalty: '+2' });

    const h = new StackmatTimer();
    h.inspection = true;
    h.update(st('I', 0, false), 0);
    h.update(st('L', 0, false), 500);
    expect(h.phase).toBe('inspecting');
    h.update(st(' ', 10, true), 500 + 18_010);
    expect(h.update(st('S', 3000, false), 30_000)?.penalty).toBe('DNF');
  });

  it('no signal: idle and no time', () => {
    const t = new StackmatTimer();
    t.update(st('S', 1234, false), 0);
    t.update(st('S', 1234, false, false), 100);
    expect(t.hardTime).toBeNull();
    expect(t.phase).toBe('idle');
  });
});
