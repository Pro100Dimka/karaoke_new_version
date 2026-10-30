import { useEffect } from "react";
import { refreshMotion } from "@neo-ui-kit/react";
import { Outlet, useLocation } from "react-router-dom";
import { KaraokeHost } from "../features/karaoke/KaraokeHost";
import { useKaraokeTv } from "../features/karaoke/tv/karaokeTv";
import { TvRemote } from "../features/karaoke/tv/TvRemote";
import { RoomDock } from "../features/room/RoomDock";
import { RoomSync } from "../features/room/RoomSync";
import SettingsModal from "../features/settings";
import { desktopClient } from "../services/desktopClient";
import { routes } from "../shared/routes";
import "./app.css";
import { AppCloseFlow } from "./AppCloseFlow";
import { useApp, useSettingsDialog } from "./AppContext";
import { LibraryBackdrop } from "./backdrop/LibraryBackdrop";
import { publishSpectrum } from "./backdrop/spectrumEvents";
import { useSpectrumFeed } from "./backdrop/useSpectrumFeed";
import { DesktopShellBridge } from "./desktop/DesktopShellBridge";
import { FloatingControls } from "./FloatingControls";
import { RadioProvider } from "./RadioContext";
import { ServiceBanner } from "./ServiceBanner";
import { StartupRecovery } from "./StartupRecovery";
import { TitleBar } from "./TitleBar";
import { useAppOnScreen } from "./useAppOnScreen";

const isKaraoke = (pathname: string): boolean =>
  pathname.startsWith("/karaoke/");

const RouteSurface = ({
  animateBackground,
}: {
  animateBackground: boolean;
}) => {
  const { settingsOpen } = useSettingsDialog();
  useEffect(refreshMotion, [settingsOpen]);
  return (
    <>
      {/* Hears the radio and the microphone through AudioService's spectrum. It stays mounted under
          Settings: re-creating the WebGL scene on close would recompile its shaders. */}
      {animateBackground && <LibraryBackdrop listening={!settingsOpen} />}
      <div
        className="routeSurface"
        data-ad-offscreen={settingsOpen ? "" : undefined}
      >
        <ServiceBanner />
        <Outlet />
      </div>
    </>
  );
};

const Shell = () => {
  const { pathname } = useLocation();
  // While Karaoke plays on the TV the laptop shows the Library, but it is not the Library's turn to
  // make sound or light: the radio is off and the backdrop rests.
  const onTv = useKaraokeTv()?.active === true;
  const isLibrary = pathname === routes.library;
  const libraryActive = isLibrary && !onTv;
  const { preferences } = useApp("preferences");
  const { localProcessing } = useApp("processing");
  const onScreen = useAppOnScreen();
  const karaoke = isKaraoke(pathname) || onTv;
  useSpectrumFeed(
    onScreen && !preferences.reducedMotion && !localProcessing,
    publishSpectrum,
    karaoke ? 1000 / 60 : 50,
  );

  // F11 toggles Karaoke fullscreen only; it never fires on other work zones. Leaving Karaoke undoes
  // only a full screen that F11 started there: one chosen from the title bar stays.
  // While Karaoke is open (here or on the TV) the screen stays on: singers do not touch the mouse.
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
    <RadioProvider libraryActive={libraryActive}>
      <div className="app">
        <DesktopShellBridge />
        <TitleBar />
        <RouteSurface
          animateBackground={
            libraryActive &&
            onScreen &&
            !preferences.reducedMotion &&
            !localProcessing
          }
        />
        {isLibrary && <FloatingControls />}
        {isLibrary && onTv && <TvRemote />}
        <AppCloseFlow />
        <StartupRecovery />
        <RoomSync />
        <RoomDock />
        <SettingsModal />
      </div>
    </RadioProvider>
  );
};

export const AppShell = () => (
  <KaraokeHost>
    <Shell />
  </KaraokeHost>
);
