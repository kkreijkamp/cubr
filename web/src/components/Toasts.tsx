import { CheckCircleIcon, CrownIcon, InfoIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { dismissToast, useToasts } from '../lib/toast';

const ICONS = { notice: InfoIcon, success: CheckCircleIcon, error: WarningCircleIcon, pb: CrownIcon };

export function Toasts() {
  const toasts = useToasts();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => {
        const Icon = ICONS[t.type];
        return (
          <div key={t.id} className={`toast ${t.type}${t.important ? ' important' : ''}`} onClick={() => dismissToast(t.id)}>
            <div className="title">
              <Icon size={14} /> {t.title}
            </div>
            <div>{t.message}</div>
          </div>
        );
      })}
    </div>
  );
}
