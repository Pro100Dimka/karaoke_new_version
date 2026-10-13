import { useEffect } from "react";
// QuantumBackground is disabled for now: it cannot hear AudioService (radio, microphone) and leaves vignette margins.
// import { QuantumBackground } from "@neo-ui-kit/react";
import { Outlet, useLocation } from "react-router-dom";
import { RoomDock } from "../features/room/RoomDock";
import { RoomSync } from "../features/room/RoomSync";
import SettingsModal from "../features/settings";
import { desktopClient } from "../services/desktopClient";
import "./app.css";
import { AppCloseFlow } from "./AppCloseFlow";
import { useSpectrumFeed } from "./backdrop/useSpectrumFeed";
import { publishSpectrum } from "./backdrop/spectrumEvents";
import { useAppOnScreen } from "./useAppOnScreen";
import { FloatingControls } from "./FloatingControls";
import { RadioProvider } from "./RadioContext";
import { routes } from "../shared/routes";
import { ServiceBanner } from "./ServiceBanner";
import { StartupRecovery } from "./StartupRecovery";
import { TitleBar } from "./TitleBar";
import { useApp, useSettingsDialog } from "./AppContext";

const isKaraoke = (pathname: string): boolean =>
  pathname.startsWith("/karaoke/");

const RouteSurface = () => {
  const { settingsOpen } = useSettingsDialog();
  return (
    <>
      {/* {animateBackground && !settingsOpen && (
        <QuantumBackground className="libraryBackdrop" aria-hidden inert />
      )} */}
      <div className="routeSurface" data-ad-offscreen={settingsOpen ? "" : undefined}>
        <ServiceBanner />
        <Outlet />
      </div>
    </>
  );
};

export const AppShell = () => {
  const { pathname } = useLocation();
  const isLibrary = pathname === routes.library;
  const { preferences } = useApp("preferences");
  const onScreen = useAppOnScreen();
  useSpectrumFeed(onScreen && !preferences.reducedMotion, publishSpectrum);

  // F11 toggles Karaoke fullscreen only; it never fires on other work zones.
  useEffect(() => {
    if (!isKaraoke(pathname)) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "F11") return;
      event.preventDefault();
      void desktopClient.toggleFullscreen();
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      void desktopClient
        .isFullscreen()
        .then((active) => active && desktopClient.toggleFullscreen());
    };
  }, [pathname]);

  return (
    <RadioProvider libraryActive={isLibrary}>
      <div className="app">
        <TitleBar />
        {/* animateBackground={isLibrary && onScreen && !preferences.reducedMotion} */}
        <RouteSurface />
        {isLibrary && <FloatingControls />}
        <AppCloseFlow />
        <StartupRecovery />
        <RoomSync />
        <RoomDock />
        <SettingsModal />
      </div>
    </RadioProvider>
  );
};
