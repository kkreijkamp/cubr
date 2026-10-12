import { useState, type ReactNode } from 'react';
import { Modal } from '../Modal';
import './dialogs.css';

interface ConfirmProps {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}

/** Small confirmation dialog; the confirm button is focused so Enter confirms. */
export function ConfirmModal({ title, message, confirmLabel = 'delete', danger = true, onConfirm, onClose }: ConfirmProps) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose} center>
      <div className="dialog-message">{message}</div>
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>
          cancel
        </button>
        <button
          className={`btn ${danger ? 'danger' : 'primary'}`}
          autoFocus
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
              onClose();
            } finally {
              setBusy(false);
            }
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

interface PromptProps {
  title: string;
  label?: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  maxLength?: number;
  /** return an error message to block submission */
  validate?: (value: string) => string | null;
  onSubmit: (value: string) => void | Promise<void>;
  onClose: () => void;
}

/** Single text-field dialog (session names etc.). Enter submits, Esc cancels. */
export function PromptModal({ title, label, initial = '', placeholder, confirmLabel = 'save', maxLength = 40, validate, onSubmit, onClose }: PromptProps) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const err = validate?.(value) ?? null;
    if (err) {
      setError(err);
      return;
    }
    try {
      await onSubmit(value.trim());
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title={title} onClose={onClose} center>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="field">
          {label && <label htmlFor="prompt-input">{label}</label>}
          <input
            id="prompt-input"
            autoFocus
            value={value}
            maxLength={maxLength}
            placeholder={placeholder}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            onFocus={(e) => e.currentTarget.select()}
          />
          {error && <div className="error-text">{error}</div>}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            cancel
          </button>
          <button type="submit" className="btn primary">
            {confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
