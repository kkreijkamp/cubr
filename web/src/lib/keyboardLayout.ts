// The keyboard's own layout, so a key is shown as it's printed (an AZERTY a, not q): the Keyboard
// API where the browser has it (Chromium); elsewhere keys are shown as on a US keyboard.
import { useEffect } from 'react';
import { createStore, useStore } from './store';

const layoutStore = createStore<ReadonlyMap<string, string> | null>(null);
let asked = false;

interface KeyboardApi {
  getLayoutMap?: () => Promise<ReadonlyMap<string, string>>;
}

/** what each key (KeyboardEvent.code) prints, once the browser has said (null until then, or without the API) */
export function useKeyboardLayout(): ReadonlyMap<string, string> | null {
  useEffect(() => {
    if (asked) return;
    asked = true;
    const kb = (navigator as Navigator & { keyboard?: KeyboardApi }).keyboard;
    kb?.getLayoutMap?.().then(
      (m) => layoutStore.set(m),
      () => {},
    );
  }, []);
  return useStore(layoutStore);
}
