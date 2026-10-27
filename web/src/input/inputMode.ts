// How times are entered on the timer page (csTimer's "entering in times with"). Kept per device, not
// with the synced settings: a stackmat or a bluetooth cube belongs to this computer.
import { createStore, loadJson, saveJson, useStore } from '../lib/store';

export type InputMode = 'timer' | 'typing' | 'stackmat' | 'moyu' | 'virtual' | 'smartcube' | 'qcube' | 'bttimer';

export interface InputModeInfo {
  id: InputMode;
  label: string;
  /** a line on what it is */
  hint: string;
  /** csTimer's ctrl+alt key */
  key: string;
}

export const INPUT_MODES: InputModeInfo[] = [
  { id: 'timer', label: 'timer', hint: 'space bar or touch', key: 't' },
  { id: 'typing', label: 'typing', hint: 'type each time in', key: 'i' },
  { id: 'stackmat', label: 'stackmat', hint: 'a stackmat timer on the microphone input', key: 's' },
  { id: 'moyu', label: 'moyu timer', hint: 'a moyu timer on the microphone input', key: 'm' },
  { id: 'virtual', label: 'virtual', hint: 'a virtual puzzle you turn with the keyboard', key: 'v' },
  { id: 'qcube', label: 'qcube', hint: 'the virtual puzzle drawn flat', key: 'q' },
  { id: 'smartcube', label: 'smart cube', hint: 'a bluetooth cube: GAN, Giiker, GoCube, MoYu, QiYi', key: 'g' },
  { id: 'bttimer', label: 'bluetooth timer', hint: 'a GAN or QiYi smart timer', key: 'b' },
];

/** the ways of entering times the timer page has so far */
export const AVAILABLE_INPUTS: InputMode[] = ['timer', 'typing', 'stackmat', 'moyu', 'virtual', 'qcube'];

export interface DeviceInputState {
  mode: InputMode;
  /** the microphone (audio input deviceId) a stackmat is plugged into; '' = the default */
  stackmatDevice: string;
  /** bluetooth MAC addresses by device name (needed for the encrypted cubes), as csTimer keeps them */
  macs: Record<string, string>;
  /** the smart cube's own reading when it was last marked solved (URFDLB facelets) */
  smartSolved: string | null;
}

const KEY = 'cubetype.input';
const MODES = new Set(INPUT_MODES.map((m) => m.id));

function load(): DeviceInputState {
  const raw = loadJson<Partial<DeviceInputState>>(KEY, {});
  return {
    mode: raw.mode && MODES.has(raw.mode) ? raw.mode : 'timer',
    stackmatDevice: typeof raw.stackmatDevice === 'string' ? raw.stackmatDevice : '',
    macs: raw.macs && typeof raw.macs === 'object' ? raw.macs : {},
    smartSolved: typeof raw.smartSolved === 'string' && raw.smartSolved.length === 54 ? raw.smartSolved : null,
  };
}

export const inputStore = createStore<DeviceInputState>(load());

export function updateInput(patch: Partial<DeviceInputState>): void {
  const next = { ...inputStore.get(), ...patch };
  inputStore.set(next);
  saveJson(KEY, next);
}

export function useInputState(): DeviceInputState {
  return useStore(inputStore);
}

export const modeInfo = (m: InputMode) => INPUT_MODES.find((x) => x.id === m)!;
