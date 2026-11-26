import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { XMarkIcon } from '@heroicons/react/24/outline';

interface ModalProps {
  title?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  /** vertically centre instead of top-aligned */
  center?: boolean;
}

/** The open dialogs, newest last: only the topmost one answers Tab and Esc. */
const openDialogs: HTMLElement[] = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** What Tab can reach inside `el`, in order (hidden elements left out). */
function focusables(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.getClientRects().length > 0);
}

/**
 * Accessible modal: named by its title, focus moves inside (to a field that asks for it with autoFocus,
 * else the dialog itself) and stays inside (Tab and Shift+Tab wrap), Esc or a backdrop click closes
 * it, and focus goes back where it was. With dialogs on top of each other, only the topmost answers.
 */
export function Modal({ title, onClose, children, wide, center }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // the latest onClose, so the effect below runs once per opening (it restores focus when it ends)
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // where focus was, read while rendering: by the time effects run, a field's autoFocus has taken it
  const [before] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    openDialogs.push(el);
    if (!el.contains(document.activeElement)) el.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (openDialogs[openDialogs.length - 1] !== el) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables(el);
      const active = document.activeElement;
      if (!items.length) {
        e.preventDefault();
        el.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (active === first || active === el || !el.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !el.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      const at = openDialogs.indexOf(el);
      if (at >= 0) openDialogs.splice(at, 1);
      // back where focus was, if that is still on the page (a link inside may have changed the page)
      if (before && before.isConnected) before.focus({ preventScroll: true });
    };
  }, [before]);

  return createPortal(
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- a click outside closes it; Esc does from the keyboard
    <div
      className={`modal-backdrop${center ? ' modal-centered' : ''}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`modal${wide ? ' wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title !== undefined ? titleId : undefined}
        tabIndex={-1}
      >
        {title !== undefined && (
          <div className="modal-title">
            <span id={titleId}>{title}</span>
            <button className="btn-text" onClick={onClose} aria-label="Close">
              <XMarkIcon />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}
