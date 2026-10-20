import { useState, type CSSProperties } from 'react';
import './Avatar.css';

export interface AvatarUser {
  username: string;
  displayName?: string | null;
  avatarUrl?: string | null;
}

interface Props {
  user: AvatarUser;
  /** diameter in px (18 for tables/nav ... 96 for the profile header) */
  size?: number;
  className?: string;
}

/**
 * Circular profile picture. Falls back to the initial-letter circle (main colour, bg-colour
 * letter) when the user has no picture, the API predates avatars, or the image fails to load.
 * Decorative (the name is always shown next to it), so it is hidden from screen readers.
 */
export function Avatar({ user, size = 20, className }: Props) {
  const url = user.avatarUrl || null;
  // remember which URL failed so a new upload (new ?v=) gets a fresh chance
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = url !== null && failedUrl !== url;
  const initial = (user.displayName?.trim() || user.username || '?').charAt(0).toLowerCase();
  const style = { '--avatar-size': `${size}px` } as CSSProperties;

  return (
    <span className={`avatar${showImage ? ' has-img' : ''}${className ? ` ${className}` : ''}`} style={style} aria-hidden="true">
      {showImage ? (
        <img src={url} alt="" width={size} height={size} loading="lazy" decoding="async" draggable={false} onError={() => setFailedUrl(url)} />
      ) : (
        initial
      )}
    </span>
  );
}
