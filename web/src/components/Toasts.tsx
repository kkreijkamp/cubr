import { CheckCircleIcon, ExclamationCircleIcon, InformationCircleIcon, TrophyIcon } from '@heroicons/react/24/outline';
import { dismissToast, useToasts } from '../lib/toast';

const ICONS = { notice: InformationCircleIcon, success: CheckCircleIcon, error: ExclamationCircleIcon, pb: TrophyIcon };

export function Toasts() {
  const toasts = useToasts();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => {
        const Icon = ICONS[t.type];
        return (
          <div key={t.id} className={`toast ${t.type}${t.important ? ' important' : ''}`} onClick={() => dismissToast(t.id)}>
            <div className="title">
              <Icon width={14} height={14} /> {t.title}
            </div>
            <div>{t.message}</div>
          </div>
        );
      })}
    </div>
  );
}
