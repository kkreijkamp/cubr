import { BeakerIcon } from '@heroicons/react/24/outline';
import { practiceMarker } from '../lib/format';
import './SessionName.css';

/**
 * The little bottle after a practice session's name (its solves count for no pb or leaderboard).
 * Screen readers hear "practice" unless the name already says so.
 */
export function PracticeBottle({ name }: { name?: string | null }) {
  const label = practiceMarker(name, true, 'practice');
  return label ? <BeakerIcon className="practice-bottle" role="img" aria-label={label} aria-hidden={false} /> : <BeakerIcon className="practice-bottle" />;
}

/**
 * A session's name, with the practice bottle after it for a practice session. A long name gets the
 * ellipsis; the bottle always stays in view.
 */
export function SessionName({ name, practice, title }: { name: string; practice?: boolean; title?: string }) {
  return (
    <span className="session-name" title={title}>
      <span className="session-name-text">{name}</span>
      {practice && <PracticeBottle name={name} />}
    </span>
  );
}
