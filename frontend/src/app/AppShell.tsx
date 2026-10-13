import { useEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { RoomDock } from "../features/room/RoomDock";
import { RoomSync } from "../features/room/RoomSync";
import SettingsModal from "../features/settings";
import { desktopClient } from "../services/desktopClient";
import "./app.css";
import { AppCloseFlow } from "./AppCloseFlow";
import { LibraryBackdrop } from "./backdrop/LibraryBackdrop";
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

const RouteSurface = ({ animateBackground }: { animateBackground: boolean }) => {
  const { settingsOpen } = useSettingsDialog();
  return (
    <>
      {/* Hears the radio and the microphone through AudioService's spectrum. It stays mounted under
          Settings: re-creating the WebGL scene on close would recompile its shaders. */}
      {animateBackground && <LibraryBackdrop listening={!settingsOpen} />}
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

  // F11 toggles Karaoke fullscreen only; it never fires on other work zones. Leaving Karaoke undoes
  // only a full screen that F11 started there: one chosen from the title bar stays.
  // While Karaoke is open the screen stays on: singers do not touch the mouse during a song.
  const karaoke = isKaraoke(pathname);
  useEffect(() => {
    if (!karaoke) return;
    void desktopClient.keepDisplayAwake(true);
    return () => void desktopClient.keepDisplayAwake(false);
  }, [karaoke]);

  useEffect(() => {
    if (!isKaraoke(pathname)) return;
    let enteredByF11 = false;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "F11") return;
      event.preventDefault();
      void desktopClient.toggleFullscreen().then((active) => {
        enteredByF11 = active;
      });
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      if (!enteredByF11) return;
      void desktopClient
        .isFullscreen()
        .then((active) => active && desktopClient.toggleFullscreen());
    };
  }, [pathname]);

  return (
    <RadioProvider libraryActive={isLibrary}>
      <div className="app">
        <TitleBar />
        <RouteSurface animateBackground={isLibrary && onScreen && !preferences.reducedMotion} />
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
