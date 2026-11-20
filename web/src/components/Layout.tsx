import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  CalendarDaysIcon,
  ClockIcon,
  CodeBracketIcon,
  Cog6ToothIcon,
  CommandLineIcon,
  EnvelopeIcon,
  FlagIcon,
  HeartIcon,
  GlobeAltIcon,
  InformationCircleIcon,
  SwatchIcon,
  TrophyIcon,
  UserIcon,
} from '@heroicons/react/24/outline';
import { Avatar } from './Avatar';
import { CubeLogo } from './CubeLogo';
import { Toasts } from './Toasts';
import { CommandPalette, usePaletteHotkeys } from './CommandPalette';
import { GlobalCommands } from './GlobalCommands';
import { LocalUploadOffer } from './timer/LocalUploadOffer';
import { PatchNotesModal } from './PatchNotesModal';
import { useAuth } from '../lib/auth';
import { openPalette } from '../lib/commands';
import { CONTACT_EMAIL, DONATE_URL, REPO_URL } from '../lib/links';
import { useActiveTheme } from '../lib/settings';
import { themeLabel } from '../lib/themes';
import { api } from '../lib/api';
import { useLaunchQueue } from '../lib/pwa';

const NAV = [
  { to: '/', icon: ClockIcon, label: 'timer', end: true },
  { to: '/daily', icon: CalendarDaysIcon, label: 'daily challenge' },
  { to: '/race', icon: FlagIcon, label: 'race' },
  { to: '/leaderboards', icon: TrophyIcon, label: 'leaderboards' },
  { to: '/wca', icon: GlobeAltIcon, label: 'wca rankings' },
  { to: '/about', icon: InformationCircleIcon, label: 'about', hideMobile: true },
  { to: '/settings', icon: Cog6ToothIcon, label: 'settings' },
];

function Header() {
  const { user, status } = useAuth();
  return (
    <header className="header">
      <Link to="/" className="logo" aria-label="cubr home">
        <CubeLogo className="logo-icon" />
        <span className="logo-text">cubr</span>
      </Link>
      <nav className="nav nav-main">
        {NAV.map(({ to, icon: Icon, label, end, hideMobile }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) => `btn-text${isActive ? ' active' : ''}${hideMobile ? ' hide-mobile' : ''}`}
            data-tip={label}
            data-tip-pos="down"
            aria-label={label}
          >
            <Icon width={20} height={20} />
          </NavLink>
        ))}
      </nav>
      <div className="nav nav-side">
        {status === 'authed' && user ? (
          <NavLink to="/account" className={({ isActive }) => `btn-text nav-user${isActive ? ' active' : ''}`} data-tip="account" data-tip-pos="down">
            {user.avatarUrl ? <Avatar user={user} size={20} className="nav-avatar" /> : <UserIcon width={20} height={20} />}
            <span className="hide-mobile">{user.username}</span>
          </NavLink>
        ) : (
          <NavLink to="/login" className={({ isActive }) => `btn-text${isActive ? ' active' : ''}`} data-tip="sign in" data-tip-pos="down" aria-label="sign in">
            <UserIcon width={20} height={20} />
          </NavLink>
        )}
      </div>
    </header>
  );
}


function Footer() {
  const theme = useActiveTheme();
  const [info, setInfo] = useState<{ version: string; pod: string } | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  useEffect(() => {
    api
      .info('/_info')
      .then((r) => setInfo({ version: r.data.version, pod: r.data.pod }))
      .catch(() => setInfo(null));
  }, []);
  return (
    <footer className="footer">
      {/* data-nosnippet: never quoted in search results ("command line github contact support ...") */}
      <div className="footer-links" data-nosnippet>
        <button className="btn-text" onClick={() => openPalette()} aria-label="command line">
          <CommandLineIcon width={14} height={14} />
          {/* the icon alone on phones: the footer keeps to two rows */}
          <span className="hide-mobile">command line</span>
        </button>
        <a href={REPO_URL} className="btn-text" target="_blank" rel="noreferrer noopener" data-tip="source code">
          <CodeBracketIcon width={14} height={14} /> github
        </a>
        <a href={`mailto:${CONTACT_EMAIL}`} className="btn-text" data-tip={CONTACT_EMAIL}>
          <EnvelopeIcon width={14} height={14} /> contact
        </a>
        <a href={DONATE_URL} className="btn-text" target="_blank" rel="noreferrer noopener" data-tip={DONATE_URL.replace(/^https:[/][/]/, '')}>
          <HeartIcon width={14} height={14} /> support
        </a>
      </div>
      <div className="footer-right" data-nosnippet>
        <Link to="/terms" className="btn-text">
          terms
        </Link>
        <Link to="/privacy" className="btn-text">
          privacy
        </Link>
        <button className="btn-text" onClick={() => openPalette('theme')} data-tip="change theme" aria-label="change theme">
          <SwatchIcon width={14} height={14} /> {themeLabel(theme)}
        </button>
        <button className="btn-text" onClick={() => setNotesOpen(true)} data-tip="patch notes" aria-haspopup="dialog">
          {info ? `v${info.version}` : 'version'}
        </button>
      </div>
      {notesOpen && <PatchNotesModal running={info?.version ?? null} onClose={() => setNotesOpen(false)} />}
    </footer>
  );
}

export function Layout() {
  usePaletteHotkeys();
  useLaunchQueue();
  const location = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
    document.body.classList.remove('focus');
  }, [location.pathname]);
  return (
    <div className="app">
      <Header />
      <main key={location.pathname} className="page">
        <Outlet />
      </main>
      <Footer />
      <Toasts />
      <CommandPalette />
      <GlobalCommands />
      <LocalUploadOffer />
    </div>
  );
}
