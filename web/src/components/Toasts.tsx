import { AlertCircle, CheckCircle2, Info } from 'lucide-react';
import { dismissToast, useToasts } from '../lib/toast';

const ICONS = { notice: Info, success: CheckCircle2, error: AlertCircle };

export function Toasts() {
  const toasts = useToasts();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => {
        const Icon = ICONS[t.type];
        return (
          <div key={t.id} className={`toast ${t.type}`} onClick={() => dismissToast(t.id)}>
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
