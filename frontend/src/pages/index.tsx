import { Router } from '@neo-ui-kit/react';
import { useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useState } from 'react';
import { ErrorBoundary } from 'react-error-boundary';

import { AppShell } from '../app/AppShell';
import { BootstrapGate } from '../app/BootstrapGate';
import { subscribeApplication } from '../providers/application';
import { subscribeCloseRequests } from '../providers/close-guards';
import { DialogView } from '../providers/dialog';
import ErrorFallback from '../providers/error-boundary';
import LocalizationProvider from '../providers/localization';
import { NotificationsProvider } from '../providers/notifications';
import { subscribeServices } from '../providers/services';
import { SocialConnection } from '../providers/social';
import ThemeConfig from '../providers/theme';
import { desktopClient } from '../services/desktopClient';
import { routePatterns, routes } from '../shared/routes';

const EditorPage = lazy(() => import('./editor'));
const LibraryPage = lazy(() => import('./library'));
const HelpPage = lazy(() => import('./help'));
const LegalDocuments = lazy(() => import('../app/LegalDocuments'));

const KaraokePage = lazy(() =>
  import('../features/karaoke/KaraokePage').then((module) => ({
    default: module.KaraokePage,
  })),
);

const appRoutes = [
  ...[
    { path: routePatterns.library, element: <LibraryPage /> },
    { path: routePatterns.help, element: <HelpPage /> },
    { path: routePatterns.karaoke, element: <KaraokePage /> },
    { path: routePatterns.editor, element: <EditorPage /> },
  ].map((route) => ({
    ...route,
    element: <AppShell>{route.element}</AppShell>,
  })),
  { path: '*', redirectTo: routes.library },
];

const App = () => {
  const client = useQueryClient();
  const [legalOpen, setLegalOpen] = useState(false);
  useEffect(
    () => desktopClient.onLegalDocuments?.(() => setLegalOpen(true)),
    [],
  );

  useEffect(() => subscribeApplication(client), [client]);
  useEffect(subscribeCloseRequests, []);
  useEffect(subscribeServices, []);

  return (
    <LocalizationProvider>
      <ThemeConfig>
        <NotificationsProvider>
          <ErrorBoundary
            FallbackComponent={ErrorFallback}
            onError={() => void desktopClient.appReady()}
          >
            <DialogView />
            {legalOpen && (
              <Suspense>
                <LegalDocuments onClose={() => setLegalOpen(false)} />
              </Suspense>
            )}
            <BootstrapGate>
              <SocialConnection />
              <Suspense
                fallback={<div className="libraryCurtain" aria-hidden />}
              >
                <Router routes={appRoutes} transition />
              </Suspense>
            </BootstrapGate>
          </ErrorBoundary>
        </NotificationsProvider>
      </ThemeConfig>
    </LocalizationProvider>
  );
};

export default App;
