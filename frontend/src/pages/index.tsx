import { lazy, Suspense, useEffect } from "react";
import { Router } from "@neo-ui-kit/react";
import { useQueryClient } from "@tanstack/react-query";
import { subscribeApplication } from "../providers/application";
import { AppShell } from "../app/AppShell";
import { BootstrapGate } from "../app/BootstrapGate";
import { subscribeServices } from "../providers/services";
import { subscribeCloseRequests } from "../providers/close-guards";
import { DialogView } from "../providers/dialog";
import { ErrorBoundary } from 'react-error-boundary';
import { NotificationsProvider } from "../providers/notifications";
import ErrorFallback from "../providers/error-boundary";
import ThemeConfig from "../providers/theme";
import LocalizationProvider from '../providers/localization';
import { routePatterns, routes } from "../shared/routes";
import { SocialConnection } from "../providers/social";

const EditorPage = lazy(() => import("./editor"));
const KaraokePage = lazy(() => import("../features/karaoke/KaraokePage").then(module => ({ default: module.KaraokePage })));
const LibraryPage = lazy(() => import("./library"));
const HelpPage = lazy(() => import("./help"));

const appRoutes = [
  ...[
    { path: routePatterns.library, element: <LibraryPage /> },
    { path: routePatterns.help, element: <HelpPage /> },
    { path: routePatterns.karaoke, element: <KaraokePage /> },
    { path: routePatterns.editor, element: <EditorPage /> },
  ].map(route => ({ ...route, element: <AppShell>{route.element}</AppShell> })),
  { path: "*", redirectTo: routes.library },
];

const App = () => {
  const client = useQueryClient();
  useEffect(() => subscribeApplication(client), [client]);
  useEffect(subscribeCloseRequests, []);
  useEffect(subscribeServices, []);
  return [LocalizationProvider, ThemeConfig, NotificationsProvider].reduceRight(
    (children, Provider) => <Provider>{children}</Provider>,
    <ErrorBoundary FallbackComponent={ErrorFallback}>
      <DialogView />
      <BootstrapGate>
        <SocialConnection />
        <Suspense fallback={null}><Router routes={appRoutes} transition /></Suspense>
      </BootstrapGate>
    </ErrorBoundary>,
  );
};
export default App;
