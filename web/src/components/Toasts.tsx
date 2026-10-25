import { IconAlertCircle, IconCircleCheck, IconCrown, IconInfoCircle } from '@tabler/icons-react';
import { dismissToast, useToasts } from '../lib/toast';

const ICONS = { notice: IconInfoCircle, success: IconCircleCheck, error: IconAlertCircle, pb: IconCrown };

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
