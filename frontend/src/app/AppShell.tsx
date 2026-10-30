import { subscribeAudioFocus } from "../providers/application";
import { observer } from "mobx-react-lite";
import { store } from "../providers/store";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { refreshMotion, useRouter } from "@neo-ui-kit/react";

import { KaraokeHost } from "../features/karaoke/KaraokeHost";
import { useKaraokeTv } from "../features/karaoke/tv/karaokeTv";
import { TvRemote } from "../features/karaoke/tv/TvRemote";
import { RoomDock } from "../features/room/RoomDock";
import { RoomSync } from "../features/room/RoomSync";
import SettingsModal from "../pages/library/modals/settings";
import { desktopClient } from "../services/desktopClient";
import { routes } from "../shared/routes";
import "./app.css";
import { AppCloseFlow } from "./AppCloseFlow";

import { LibraryBackdrop } from "../pages/library/background";
import { publishSpectrum } from "./backdrop/spectrumEvents";
import { useSpectrumFeed } from "./backdrop/useSpectrumFeed";
import { DesktopShellBridge } from "./desktop/DesktopShellBridge";
import { FloatingControls } from "./FloatingControls";
import { subscribeRadio } from "../providers/radio";
import { runInAction } from "mobx";
import { useNotify } from "../providers/notifications";
import { ServiceBanner } from "./ServiceBanner";
import { StartupRecovery } from "./StartupRecovery";
import { TitleBar } from "./TitleBar";
import { useAppOnScreen } from "./useAppOnScreen";

const isKaraoke = (pathname: string): boolean =>
  pathname.startsWith("/karaoke/");

const RouteSurface = observer(({
  animateBackground, children,
}: {
  children?: ReactNode;
  animateBackground: boolean;
}) => {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsOpenRef = useRef(settingsOpen);
  settingsOpenRef.current = settingsOpen;
  useEffect(() => subscribeAudioFocus(() => settingsOpenRef.current), []);
  useEffect(refreshMotion, [settingsOpen]);
  return (
    <>
      {/* Hears the radio and the microphone through AudioService's spectrum. It stays mounted under
          Settings: re-creating the WebGL scene on close would recompile its shaders. */}
      {animateBackground && <LibraryBackdrop paused={settingsOpen} />}
      <div
        className="routeSurface"
        data-ad-offscreen={settingsOpen ? "" : undefined}
      >
        <ServiceBanner />
        {children}
      </div>
      <SettingsModal onOpenChange={setSettingsOpen} />
    </>
  );
});

const Shell = observer(({ children }: { children?: ReactNode }) => {
  const { pathname } = useRouter();
  // While Karaoke plays on the TV the laptop shows the Library, but it is not the Library's turn to
  // make sound or light: the radio is off and the backdrop rests.
  const onTv = useKaraokeTv()?.active === true;
  const isLibrary = pathname === routes.library;
  const libraryActive = isLibrary && !onTv;
  useEffect(() => { if (!isLibrary) store.returnFromKaraoke(null); }, [isLibrary]);
  const notify = useNotify();
  useEffect(() => { runInAction(() => { store.radio.libraryActive = libraryActive; }); }, [libraryActive]);
  useEffect(() => subscribeRadio(notify), [notify]);
  const { preferences } = store;
  const { localProcessing } = store.application;
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
        >{children}</RouteSurface>
        {isLibrary && <FloatingControls />}
        {isLibrary && onTv && <TvRemote />}
        <AppCloseFlow />
        <StartupRecovery />
        <RoomSync />
        <RoomDock />
      </div>
  );
});

export const AppShell = ({ children }: { children?: ReactNode }) => (
  <KaraokeHost>
    <Shell>{children}</Shell>
  </KaraokeHost>
);
