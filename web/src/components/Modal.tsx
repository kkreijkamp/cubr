import { useEffect, type ReactNode } from 'react';
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

/** Accessible modal: Esc / backdrop click closes, focus moves inside. */
export function Modal({ title, onClose, children, wide, center }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal(
    <div
      className={`modal-backdrop${center ? ' modal-centered' : ''}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true">
        {title !== undefined && (
          <div className="modal-title">
            <span>{title}</span>
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
