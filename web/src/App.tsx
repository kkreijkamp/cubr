import { lazy, Suspense } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { Layout } from './components/Layout';
import { RouteError } from './components/RouteError';
import { Loading } from './components/Spinner';
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
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));

const s = (el: JSX.Element) => <Suspense fallback={<Loading />}>{el}</Suspense>;

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
          { path: '/daily', element: s(<DailyPage />) },
          { path: '/race', element: s(<RaceLobbyPage />) },
          { path: '/race/:roomId', element: s(<RaceRoomPage />) },
          { path: '/profile/:username', element: s(<ProfilePage />) },
          { path: '/account', element: s(<AccountPage />) },
          { path: '/settings', element: s(<SettingsPage />) },
          { path: '/wca', element: s(<WcaPage />) },
          { path: '/about', element: s(<AboutPage />) },
          { path: '/login', element: s(<LoginPage />) },
          { path: '*', element: s(<NotFoundPage />) },
        ],
      },
    ],
  },
], {
  // opt in to React Router v7 behaviour now (silences the future-flag console warnings)
  future: { v7_relativeSplatPath: true, v7_fetcherPersist: true, v7_normalizeFormMethod: true, v7_partialHydration: true, v7_skipActionErrorRevalidation: true },
});

export function App() {
  return (
    <AuthProvider>
      <RouterProvider router={router} future={{ v7_startTransition: true }} />
    </AuthProvider>
  );
}
