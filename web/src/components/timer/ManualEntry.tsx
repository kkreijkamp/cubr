import { useEffect, useRef, useState } from 'react';
import { parseTimeInput, type Penalty } from '@cubetype/cubestats';
import { parseManualEntry } from './statsUtil';

interface Props {
  onSubmit: (r: { timeMs: number; penalty: Penalty }) => void;
  disabled?: boolean;
}

/** Typing mode: the input replaces the timer; Enter saves the time. */
export function ManualEntry({ onSubmit, disabled }: Props) {
  const [value, setValue] = useState('');
  const [error, setError] = useState(false);
  const [shake, setShake] = useState(0);
  const ref = useRef<HTMLInputElement>(null);

  // focus the input — also after an invalid time, which re-mounts it to restart the shake animation
  useEffect(() => {
    if (!disabled) ref.current?.focus();
  }, [disabled, shake]);

  const submit = () => {
    const r = parseManualEntry(value, parseTimeInput);
    if (!r) {
      setError(true);
      setShake((n) => n + 1);
      return;
    }
    onSubmit(r);
    setValue('');
    setError(false);
  };

  return (
    <div className="tp-manual">
      <input
        ref={ref}
        key={shake}
        data-manual-entry
        className={`tp-manual-input${error ? ' invalid shake' : ''}`}
        value={value}
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        placeholder="0.00"
        aria-label="type a time and press enter"
        disabled={disabled}
        onChange={(e) => {
          setValue(e.target.value);
          setError(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          } else if (e.key === 'Escape') {
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <div className={`tp-manual-hint${error ? ' error' : ''}`}>
        {error ? (
          "that doesn't look like a time"
        ) : (
          <>
            <kbd>enter</kbd> save · 12.34 · 1:02.34 · 1234 → 12.34 · 12.34+ · dnf(12.34)
          </>
        )}
      </div>
    </div>
  );
}
