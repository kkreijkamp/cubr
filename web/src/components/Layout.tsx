import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  CalendarDaysIcon,
  ClockIcon,
  CodeBracketIcon,
  Cog6ToothIcon,
  CommandLineIcon,
  FlagIcon,
  GlobeAltIcon,
  InformationCircleIcon,
  SignalIcon,
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
import { useAuth } from '../lib/auth';
import { openPalette } from '../lib/commands';
import { useSettings } from '../lib/settings';
import { themeLabel } from '../lib/themes';
import { api } from '../lib/api';

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
        <NavLink to="/status" className={({ isActive }) => `btn-text hide-mobile${isActive ? ' active' : ''}`} data-tip="cluster status" data-tip-pos="down" aria-label="cluster status">
          <SignalIcon width={20} height={20} />
        </NavLink>
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

/** The source code (a private repository: it opens for the people who have access). */
const REPO_URL = 'https://github.com/kkreijkamp/cubetype';

function Footer() {
  const settings = useSettings();
  const [info, setInfo] = useState<{ version: string; pod: string } | null>(null);
  useEffect(() => {
    api
      .info('/_info')
      .then((r) => setInfo({ version: r.data.version, pod: r.data.pod }))
      .catch(() => setInfo(null));
  }, []);
  return (
    <footer className="footer">
      <div className="footer-links">
        <button className="btn-text" onClick={() => openPalette()}>
          <CommandLineIcon width={14} height={14} /> <kbd>esc</kbd> command line
        </button>
        <Link to="/status" className="btn-text">
          <SignalIcon width={14} height={14} /> status
        </Link>
        <Link to="/about" className="btn-text">
          <InformationCircleIcon width={14} height={14} /> about
        </Link>
        <a href={REPO_URL} className="btn-text" target="_blank" rel="noreferrer noopener" data-tip="source code (private repo)">
          <CodeBracketIcon width={14} height={14} /> github
        </a>
      </div>
      <div className="footer-right">
        <button className="btn-text" onClick={() => openPalette('theme')} data-tip="change theme" aria-label="change theme">
          <SwatchIcon width={14} height={14} /> {themeLabel(settings.theme)}
        </button>
        <Link to="/status" className="btn-text" data-tip={info ? `served by ${info.pod}` : 'version'}>
          {info ? `v${info.version}` : 'version'}
        </Link>
      </div>
    </footer>
  );
}

export function Layout() {
  usePaletteHotkeys();
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
