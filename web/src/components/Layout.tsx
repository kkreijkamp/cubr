import { useEffect } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { CalendarDays, Crown, Keyboard, Palette, Settings, Swords, Timer, User } from 'lucide-react';
import { CubeLogo } from './CubeLogo';
import { Toasts } from './Toasts';
import { CommandPalette, usePaletteHotkeys } from './CommandPalette';
import { GlobalCommands } from './GlobalCommands';
import { useAuth } from '../lib/auth';
import { openPalette } from '../lib/commands';
import { useSettings } from '../lib/settings';
import { themeLabel } from '../lib/themes';

const NAV = [
  { to: '/', icon: Timer, label: 'timer', end: true },
  { to: '/daily', icon: CalendarDays, label: 'daily challenge' },
  { to: '/race', icon: Swords, label: 'race' },
  { to: '/leaderboards', icon: Crown, label: 'leaderboards' },
  { to: '/settings', icon: Settings, label: 'settings' },
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
      <nav className="nav">
        {NAV.map(({ to, icon: Icon, label, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) => `btn-text${isActive ? ' active' : ''}`}
            data-tip={label}
            data-tip-pos="down"
            aria-label={label}
          >
            <Icon size={20} />
          </NavLink>
        ))}
        <div className="spacer" />
        {status === 'authed' && user ? (
          <NavLink to="/account" className={({ isActive }) => `btn-text nav-user${isActive ? ' active' : ''}`} data-tip="account" data-tip-pos="down">
            <User size={20} />
            <span className="hide-mobile">{user.username}</span>
          </NavLink>
        ) : (
          <NavLink to="/login" className={({ isActive }) => `btn-text${isActive ? ' active' : ''}`} data-tip="sign in" data-tip-pos="down" aria-label="sign in">
            <User size={20} />
          </NavLink>
        )}
      </nav>
    </header>
  );
}

function Footer() {
  const settings = useSettings();
  return (
    <footer className="footer">
      <div className="footer-links">
        <button className="btn-text" onClick={() => openPalette()}>
          <Keyboard size={14} /> <kbd>esc</kbd> command line
        </button>
      </div>
      <div className="footer-right">
        <button className="btn-text" onClick={() => openPalette('theme')} data-tip="change theme" aria-label="change theme">
          <Palette size={14} /> {themeLabel(settings.theme)}
        </button>
        <span>v{import.meta.env.VITE_APP_VERSION ?? 'dev'}</span>
      </div>
    </footer>
  );
}

export function Layout() {
  usePaletteHotkeys();
  const location = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
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
    </div>
  );
}
