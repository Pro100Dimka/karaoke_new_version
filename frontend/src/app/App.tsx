import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { EditorPage } from "../features/editor/EditorPage";
import { KaraokePage } from "../features/karaoke/KaraokePage";
import { LibraryPage } from "../features/library/LibraryPage";
import { AppProvider } from "./AppContext";
import { AppShell } from "./AppShell";
import { BootstrapGate } from "./BootstrapGate";
import { ServicesProvider } from "./ServicesContext";
import { CloseGuardsProvider } from "./CloseGuards";
import { DialogProvider } from "./DialogProvider";
import { NotificationsProvider } from "./NotificationsProvider";
import { GlobalErrorBoundary } from "./GlobalErrorBoundary";
import { routePatterns, routes } from "./routes";

const RoutedApp = () => (
  <HashRouter>
    <Routes>
      <Route element={<AppShell />}>
        <Route path={routePatterns.library} element={<LibraryPage />} />
        <Route path={routePatterns.karaoke} element={<KaraokePage />} />
        <Route path={routePatterns.editor} element={<EditorPage />} />
        <Route path="*" element={<Navigate to={routes.library} replace />} />
      </Route>
    </Routes>
  </HashRouter>
);

const ThemedApp = () => (
  <NotificationsProvider>
    <DialogProvider>
      <CloseGuardsProvider>
        <ServicesProvider>
          <BootstrapGate>
            <RoutedApp />
          </BootstrapGate>
        </ServicesProvider>
      </CloseGuardsProvider>
    </DialogProvider>
  </NotificationsProvider>
);

export const App = () => (
  <GlobalErrorBoundary>
    <AppProvider>
      <ThemedApp />
    </AppProvider>
  </GlobalErrorBoundary>
);
