import { lazy, Suspense } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { Layout } from './components/Layout';
import { RouteError } from './components/RouteError';
import { Loading, PageLoading } from './components/Spinner';
import { AuthProvider } from './lib/auth';
import TimerPage from './pages/TimerPage';

// Everything except the timer is code-split so the first paint is just the timer.
const LeaderboardsPage = lazy(() => import('./pages/LeaderboardsPage'));
const DailyPage = lazy(() => import('./pages/DailyPage'));
const RaceLobbyPage = lazy(() => import('./pages/RaceLobbyPage'));
const RaceRoomPage = lazy(() => import('./pages/RaceRoomPage'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));
const AccountPage = lazy(() => import('./pages/AccountPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const WcaPage = lazy(() => import('./pages/WcaPage'));
const AboutPage = lazy(() => import('./pages/AboutPage'));
const LoginPage = lazy(() => import('./pages/LoginPage'));
const ResetPasswordPage = lazy(() => import('./pages/LoginPage').then((m) => ({ default: m.ResetPasswordPage })));
const ConfirmEmailPage = lazy(() => import('./pages/LoginPage').then((m) => ({ default: m.ConfirmEmailPage })));
const SsoPage = lazy(() => import('./pages/SsoPage'));
const TermsPage = lazy(() => import('./pages/LegalPage').then((m) => ({ default: m.TermsPage })));
const PrivacyPage = lazy(() => import('./pages/LegalPage').then((m) => ({ default: m.PrivacyPage })));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));

const s = (el: JSX.Element) => <Suspense fallback={<Loading />}>{el}</Suspense>;
// a page that always ends up taller than the screen: its loading state holds a screen's height, so the
// footer isn't pushed off the screen when the page arrives (see PageLoading). Not for pages that can end
// up shorter (the leaderboards with few entries, a race lobby with no rooms): their footer would rise.
const tall = (el: JSX.Element) => <Suspense fallback={<PageLoading />}>{el}</Suspense>;

const router = createBrowserRouter([
  {
    element: <Layout />,
    errorElement: <RouteError />,
    children: [
      {
        // a page that fails (e.g. its chunk is gone after a rollout) renders inside the layout
        errorElement: <RouteError />,
        children: [
          { path: '/', element: <TimerPage /> },
          { path: '/leaderboards', element: s(<LeaderboardsPage />) },
          { path: '/daily', element: tall(<DailyPage />) },
          { path: '/race', element: s(<RaceLobbyPage />) },
          { path: '/race/:roomId', element: s(<RaceRoomPage />) },
          { path: '/profile/:username', element: tall(<ProfilePage />) },
          { path: '/account', element: tall(<AccountPage />) },
          { path: '/settings', element: tall(<SettingsPage />) },
          { path: '/wca', element: s(<WcaPage />) },
          { path: '/about', element: tall(<AboutPage />) },
          { path: '/login', element: s(<LoginPage />) },
          // sign-in with Google, Apple or GitHub lands here
          { path: '/login/sso', element: s(<SsoPage />) },
          { path: '/reset', element: s(<ResetPasswordPage />) },
          { path: '/confirm-email', element: s(<ConfirmEmailPage />) },
          { path: '/terms', element: tall(<TermsPage />) },
          { path: '/privacy', element: tall(<PrivacyPage />) },
          { path: '*', element: s(<NotFoundPage />) },
        ],
      },
    ],
  },
]);

export function App() {
  return (
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  );
}
