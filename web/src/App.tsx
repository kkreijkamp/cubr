import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { Layout } from './components/Layout';
import TimerPage from './pages/TimerPage';
import NotFoundPage from './pages/NotFoundPage';

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <TimerPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
], {
  // opt in to React Router v7 behaviour now (silences the future-flag console warnings)
  future: { v7_relativeSplatPath: true, v7_fetcherPersist: true, v7_normalizeFormMethod: true, v7_partialHydration: true, v7_skipActionErrorRevalidation: true },
});

export function App() {
  return <RouterProvider router={router} future={{ v7_startTransition: true }} />;
}
