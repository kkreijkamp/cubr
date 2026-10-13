import type { CSSProperties } from 'react';
import './Avatar.css';

export interface AvatarUser {
  username: string;
  displayName?: string | null;
}

interface Props {
  user: AvatarUser;
  /** diameter in px */
  size?: number;
  className?: string;
}

/**
 * Circular avatar: the initial letter of the display name (or username) on the main colour.
 * Decorative (the name is always shown next to it), so it is hidden from screen readers.
 */
export function Avatar({ user, size = 20, className }: Props) {
  const initial = (user.displayName?.trim() || user.username || '?').charAt(0).toLowerCase();
  const style = { '--avatar-size': `${size}px` } as CSSProperties;

  return (
    <span className={`avatar${className ? ` ${className}` : ''}`} style={style} aria-hidden="true">
      {initial}
    </span>
  );
}
