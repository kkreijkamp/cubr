import { useEffect } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { Timer } from 'lucide-react';
import { CubeLogo } from './CubeLogo';
import { Toasts } from './Toasts';

const NAV = [
  { to: '/', icon: Timer, label: 'timer', end: true },
];

function Header() {
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
      </nav>
    </header>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <span>v{import.meta.env.VITE_APP_VERSION ?? 'dev'}</span>
    </footer>
  );
}

export function Layout() {
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
    </div>
  );
}
