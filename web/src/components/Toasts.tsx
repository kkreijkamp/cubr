import { CheckCircleIcon, ExclamationCircleIcon, InformationCircleIcon, TrophyIcon } from '@heroicons/react/24/outline';
import { dismissToast, useToasts } from '../lib/toast';

const ICONS = { notice: InformationCircleIcon, success: CheckCircleIcon, error: ExclamationCircleIcon, pb: TrophyIcon };

export function Toasts() {
  const toasts = useToasts();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => {
        const Icon = ICONS[t.type];
        const activate = () => {
          dismissToast(t.id);
          t.onClick?.();
        };
        // a toast with an action (e.g. "update ready - click to reload") also works from the keyboard
        const action = t.onClick ? { role: 'button', tabIndex: 0, onKeyDown: (e: React.KeyboardEvent) => e.key === 'Enter' && activate() } : {};
        return (
          // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- with an action it is a button (`action`); without, a click only dismisses it early
          <div key={t.id} className={`toast ${t.type}${t.important ? ' important' : ''}`} onClick={activate} {...action}>
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
