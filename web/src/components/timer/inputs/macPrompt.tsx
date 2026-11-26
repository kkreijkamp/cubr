import { useCallback, useRef, useState } from 'react';
import { inputStore, updateInput } from '../../../input/inputMode';
import { MAC_RE } from '../../../input/bluetooth/keys';
import { PromptModal } from '../Dialogs';

interface Ask {
  name: string;
  suggested: string | null;
  wrong: boolean;
  resolve: (mac: string | null) => void;
}

/**
 * The MAC address an encrypted cube or timer needs, csTimer's giikerutil.reqMacAddr: the one its
 * advertisement carries when the browser can read that, else the one saved for this device name,
 * else asked for (with the one its name suggests).
 */
export function useMacAddress() {
  const [ask, setAsk] = useState<Ask | null>(null);
  const pending = useRef<Ask | null>(null);

  const mac = useCallback(
    (name: string, found: string | null, suggested: string | null, opts: { force?: boolean; wrong?: boolean } = {}): Promise<string | null> => {
      const saved = inputStore.get().macs[name];
      const remember = (m: string) => {
        if (inputStore.get().macs[name]?.toUpperCase() !== m.toUpperCase()) updateInput({ macs: { ...inputStore.get().macs, [name]: m } });
        return m;
      };
      if (found) return Promise.resolve(remember(found));
      if (saved && !opts.force) return Promise.resolve(saved);
      return new Promise((resolve) => {
        const a: Ask = { name, suggested: saved ?? suggested, wrong: Boolean(opts.wrong), resolve: (m) => resolve(m ? remember(m) : null) };
        pending.current = a;
        setAsk(a);
      });
    },
    [],
  );

  const element = ask ? (
    <PromptModal
      title="MAC address"
      label={`${ask.wrong ? 'that MAC address might be wrong - ' : ''}the MAC address of ${ask.name} (xx:xx:xx:xx:xx:xx). Chrome shows it at chrome://bluetooth-internals; with chrome://flags/#enable-experimental-web-platform-features on it is found by itself.`}
      initial={ask.suggested ?? ''}
      placeholder="xx:xx:xx:xx:xx:xx"
      confirmLabel="connect"
      maxLength={17}
      validate={(v) => (MAC_RE.test(v.trim()) ? null : 'six pairs of hex digits, like ab:12:cd:34:ef:56')}
      onSubmit={(v) => {
        ask.resolve(v.trim().toUpperCase());
        pending.current = null;
      }}
      onClose={() => {
        // closing without an address gives up on this connection
        pending.current?.resolve(null);
        pending.current = null;
        setAsk(null);
      }}
    />
  ) : null;

  return { mac, element };
}
