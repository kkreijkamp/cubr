// How times are entered on the timer page (csTimer's "entering in times with"). Kept per device, not
// with the synced settings: a stackmat or a bluetooth cube belongs to this computer.
import { createStore, loadJson, saveJson, useStore } from '../lib/store';

export type InputMode = 'timer' | 'typing' | 'stackmat' | 'moyu' | 'virtual' | 'smartcube' | 'qcube' | 'bttimer';

export interface InputModeInfo {
  id: InputMode;
  label: string;
  /** csTimer's ctrl+alt key */
  key: string;
}

export const INPUT_MODES: InputModeInfo[] = [
  { id: 'timer', label: 'timer', key: 't' },
  { id: 'typing', label: 'typing', key: 'i' },
  { id: 'stackmat', label: 'stackmat', key: 's' },
  { id: 'moyu', label: 'moyu timer', key: 'm' },
  { id: 'virtual', label: 'virtual', key: 'v' },
  { id: 'qcube', label: 'qcube', key: 'q' },
  { id: 'smartcube', label: 'smart cube', key: 'g' },
  { id: 'bttimer', label: 'bluetooth timer', key: 'b' },
];

/** the ways of entering times the timer page has (all of csTimer's but last layer training) */
export const AVAILABLE_INPUTS: InputMode[] = INPUT_MODES.map((m) => m.id);

export interface DeviceInputState {
  mode: InputMode;
  /** the microphone (audio input deviceId) a stackmat is plugged into; '' = the default */
  stackmatDevice: string;
  /** bluetooth MAC addresses by device name (needed for the encrypted cubes), as csTimer keeps them */
  macs: Record<string, string>;
  /** each smart cube's own reading when it was last marked solved (URFDLB facelets), by device name */
  smartSolved: Record<string, string>;
}

const KEY = 'cubr.input';
const MODES = new Set(INPUT_MODES.map((m) => m.id));

function load(): DeviceInputState {
  const raw = loadJson<Partial<DeviceInputState>>(KEY, {});
  return {
    mode: raw.mode && MODES.has(raw.mode) ? raw.mode : 'timer',
    stackmatDevice: typeof raw.stackmatDevice === 'string' ? raw.stackmatDevice : '',
    macs: raw.macs && typeof raw.macs === 'object' ? raw.macs : {},
    smartSolved: raw.smartSolved && typeof raw.smartSolved === 'object' ? raw.smartSolved : {},
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
