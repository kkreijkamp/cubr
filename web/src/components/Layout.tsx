import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  CalendarDotsIcon,
  CrownIcon,
  GearIcon,
  GlobeIcon,
  InfoIcon,
  KeyboardIcon,
  PaletteIcon,
  PulseIcon,
  SwordIcon,
  TimerIcon,
  UserIcon,
} from '@phosphor-icons/react';
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
  { to: '/', icon: TimerIcon, label: 'timer', end: true },
  { to: '/daily', icon: CalendarDotsIcon, label: 'daily challenge' },
  { to: '/race', icon: SwordIcon, label: 'race' },
  { to: '/leaderboards', icon: CrownIcon, label: 'leaderboards' },
  { to: '/wca', icon: GlobeIcon, label: 'wca rankings' },
  { to: '/about', icon: InfoIcon, label: 'about', hideMobile: true },
  { to: '/settings', icon: GearIcon, label: 'settings' },
];

function Header() {
  const { user, status } = useAuth();
  return (
    <header className="header">
      <Link to="/" className="logo" aria-label="cubetype home">
        <CubeLogo className="logo-icon" />
        <span>
          <span className="logo-sub">cube see</span>
          <span className="logo-text">cubetype</span>
        </span>
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
            <Icon size={20} />
          </NavLink>
        ))}
      </nav>
      <div className="nav nav-side">
        <NavLink to="/status" className={({ isActive }) => `btn-text hide-mobile${isActive ? ' active' : ''}`} data-tip="cluster status" data-tip-pos="down" aria-label="cluster status">
          <PulseIcon size={20} />
        </NavLink>
        {status === 'authed' && user ? (
          <NavLink to="/account" className={({ isActive }) => `btn-text nav-user${isActive ? ' active' : ''}`} data-tip="account" data-tip-pos="down">
            {user.avatarUrl ? <Avatar user={user} size={20} className="nav-avatar" /> : <UserIcon size={20} />}
            <span className="hide-mobile">{user.username}</span>
          </NavLink>
        ) : (
          <NavLink to="/login" className={({ isActive }) => `btn-text${isActive ? ' active' : ''}`} data-tip="sign in" data-tip-pos="down" aria-label="sign in">
            <UserIcon size={20} />
          </NavLink>
        )}
      </div>
    </header>
  );
}

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
          <KeyboardIcon size={14} /> <kbd>esc</kbd> command line
        </button>
        <Link to="/status" className="btn-text">
          <PulseIcon size={14} /> status
        </Link>
        <Link to="/about" className="btn-text">
          <InfoIcon size={14} /> about
        </Link>
      </div>
      <div className="footer-right">
        <button className="btn-text" onClick={() => openPalette('theme')} data-tip="change theme" aria-label="change theme">
          <PaletteIcon size={14} /> {themeLabel(settings.theme)}
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
