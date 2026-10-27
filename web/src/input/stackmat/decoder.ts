// The stackmat (and MoYu timer) signal, decoded from audio samples: csTimer's hardware/stackmat.js,
// sample for sample. A stackmat sends its state over its data port as 1200 baud serial (8N1): a
// status letter, the time in digits and a checksum. A MoYu timer sends six BCD digits at 8000 baud,
// each bit after a one-bit marker. Automatic gain first, then a Schmitt trigger turns the audio into
// levels, levels into bits, bits into bytes and bytes into packets.

export interface StackmatState {
  /** a signal is coming in */
  on: boolean;
  time_milli: number;
  /** 10 for a 5-digit timer (centiseconds), 1 for a 6-digit one (milliseconds) */
  unit: number;
  greenLight: boolean;
  leftHand: boolean;
  rightHand: boolean;
  running: boolean;
  /** the status letter: ' ' running, 'S' stopped, 'I' reset, 'L'/'R' a hand down, 'C' both, 'A' ready */
  signalHeader: string;
  unknownRunning: boolean;
  /** 0..1 how far the signal is from a clean square wave */
  noise: number;
  power: number;
}

const THRESHOLD_SCHM = 0.2;
const THRESHOLD_EDGE = 0.7;
const RE_HEAD = /[ SILRCA]/;
const RE_DIGIT = /[0-9]/;

export class StackmatDecoder {
  private readonly bitLen: number;
  private readonly agcFactor: number;
  private readonly moyu: boolean;
  /** use the status letter (csTimer "use stackmat status information"); off: every packet reads as 'S' */
  useStatus = true;
  private lastVal: number[];
  private lastSgn = 0;
  private lenVoltageKeep = 0;
  private distortionStat = 0;
  private lastPower = 1;
  private bitBuffer: number[] = [];
  private byteBuffer: string[] = [];
  private idleVal = 0;
  private lastBit = 0;
  private lastBitLength = 0;
  private noStateLength = 0;
  state: StackmatState = {
    time_milli: 0,
    unit: 10,
    on: false,
    greenLight: false,
    leftHand: false,
    rightHand: false,
    running: false,
    unknownRunning: true,
    signalHeader: 'I',
    noise: 1,
    power: 1,
  };

  constructor(
    sampleRate: number,
    kind: 'stackmat' | 'moyu',
    private readonly onState: (s: StackmatState) => void,
  ) {
    this.moyu = kind === 'moyu';
    this.bitLen = sampleRate / (this.moyu ? 8000 : 1200);
    this.agcFactor = 0.001 / this.bitLen;
    // a delay line of a sixth of a bit: an edge is a big enough change over that long
    this.lastVal = new Array(Math.ceil(this.bitLen / 6)).fill(Number.NaN);
  }

  /** feed raw audio samples */
  process(input: ArrayLike<number>): void {
    for (let i = 0; i < input.length; i++) {
      const power = input[i] * input[i];
      this.lastPower = Math.max(0.0001, this.lastPower + (power - this.lastPower) * this.agcFactor);
      const gain = 1 / Math.sqrt(this.lastPower);
      this.procSignal(input[i] * gain);
    }
  }

  private procSignal(signal: number) {
    this.lastVal.unshift(signal);
    const old = this.lastVal.pop()!;
    const sgn = this.lastSgn ? 1 : -1;
    const isEdge = (old - signal) * sgn > THRESHOLD_EDGE && Math.abs(signal - sgn) - 1 > THRESHOLD_SCHM && this.lenVoltageKeep > this.bitLen * 0.6;
    if (isEdge) {
      const n = Math.round(this.lenVoltageKeep / this.bitLen);
      for (let i = 0; i < n; i++) this.appendBit(this.lastSgn);
      this.lastSgn ^= 1;
      this.lenVoltageKeep = 0;
    } else if (this.lenVoltageKeep > this.bitLen * 2) {
      this.appendBit(this.lastSgn);
      this.lenVoltageKeep -= this.bitLen;
    }
    this.lenVoltageKeep++;
    // the signal power is normalised, so this tends to zero for a clean signal
    if (this.lastBitLength < 10) {
      this.distortionStat = Math.max(0.0001, this.distortionStat + ((signal - (this.lastSgn ? 1 : -1)) ** 2 - this.distortionStat) * this.agcFactor);
    } else if (this.lastBitLength > 100) {
      this.distortionStat = 1;
    }
  }

  private appendBit(bit: number) {
    if (this.moyu) return this.appendBitMoyu(bit);
    this.bitBuffer.push(bit);
    if (bit !== this.lastBit) {
      this.lastBit = bit;
      this.lastBitLength = 1;
    } else {
      this.lastBitLength++;
    }
    this.noStateLength++;
    if (this.lastBitLength > 10) {
      // idle line
      this.idleVal = bit;
      this.bitBuffer = [];
      this.byteBuffer = [];
      if (this.lastBitLength > 100 && this.state.on) {
        this.state = { ...this.state, on: false, noise: Math.min(1, this.distortionStat) || 0, power: this.lastPower };
        this.onState(this.state);
      } else if (this.noStateLength > 700) {
        this.noStateLength = 100;
        this.state = { ...this.state, noise: Math.min(1, this.distortionStat) || 0, power: this.lastPower };
        this.onState(this.state);
      }
    } else if (this.bitBuffer.length === 10) {
      // a frame: start bit (not idle), 8 data bits, stop bit (idle)
      if (this.bitBuffer[0] === this.idleVal || this.bitBuffer[9] !== this.idleVal) {
        this.bitBuffer = this.bitBuffer.slice(1);
      } else {
        let val = 0;
        for (let i = 8; i > 0; i--) val = (val << 1) | (this.bitBuffer[i] === this.idleVal ? 1 : 0);
        this.byteBuffer.push(String.fromCharCode(val));
        this.decode(this.byteBuffer);
        this.bitBuffer = [];
      }
    }
  }

  private decode(bytes: string[]) {
    if (bytes.length !== 9 && bytes.length !== 10) return;
    const head = bytes[0];
    if (!RE_HEAD.test(head)) return;
    let checksum = 64;
    for (let i = 1; i < bytes.length - 3; i++) {
      if (!RE_DIGIT.test(bytes[i])) return;
      checksum += Number(bytes[i]);
    }
    if (checksum !== bytes[bytes.length - 3].charCodeAt(0)) return;
    const ms = Number(bytes[1]) * 60000 + Number(bytes[2] + bytes[3]) * 1000 + Number(bytes[4] + bytes[5] + (bytes.length === 10 ? bytes[6] : '0'));
    this.pushState(head, ms, bytes.length === 9 ? 10 : 1);
  }

  private pushState(head: string, ms: number, unit: number) {
    const prev = this.state;
    if (!this.useStatus) head = 'S';
    const increasing = unit === prev.unit ? ms > prev.time_milli : Math.floor(ms / 10) > Math.floor(prev.time_milli / 10);
    this.state = {
      time_milli: ms,
      unit,
      on: true,
      greenLight: head === 'A',
      leftHand: head === 'L' || head === 'A' || head === 'C',
      rightHand: head === 'R' || head === 'A' || head === 'C',
      running: (head !== 'S' || prev.signalHeader === 'S') && (head === ' ' || increasing),
      signalHeader: head,
      unknownRunning: !prev.on,
      noise: Math.min(1, this.distortionStat) || 0,
      power: this.lastPower,
    };
    this.noStateLength = 0;
    this.onState(this.state);
  }

  private appendBitMoyu(bit: number) {
    if (this.lastBit !== this.idleVal && this.lastBitLength === 1) {
      this.bitBuffer.push(bit);
      if (this.bitBuffer.length === 24) {
        let ms = 0;
        for (let i = 5; i >= 0; i--) {
          ms *= 10;
          for (let j = 0; j < 4; j++) ms += this.bitBuffer[i * 4 + j] << j;
        }
        this.bitBuffer = [];
        this.pushState('S', ms, 1);
      }
    }
    if (bit !== this.lastBit) {
      this.lastBit = bit;
      this.lastBitLength = 1;
    } else {
      this.lastBitLength++;
    }
    if (this.lastBitLength > 10) {
      this.idleVal = bit;
      this.bitBuffer = [];
      this.byteBuffer = [];
      if (this.lastBitLength > 1000 && this.state.on) {
        this.state = { ...this.state, on: false, noise: Math.min(1, this.distortionStat) || 0, power: this.lastPower };
        this.onState(this.state);
      } else if (this.lastBitLength > 4000) {
        this.lastBitLength = 1000;
        this.state = { ...this.state, noise: Math.min(1, this.distortionStat) || 0, power: this.lastPower };
        this.onState(this.state);
      }
    }
  }
}
