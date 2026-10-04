import "./app.css";
import { useEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { RoomDock } from "../features/room/RoomDock";
import { RoomSync } from "../features/room/RoomSync";
import { SettingsModal } from "../features/settings/SettingsModal";
import { desktopClient } from "../services/desktopClient";
import { AppCloseFlow } from "./AppCloseFlow";
import { StartupRecovery } from "./StartupRecovery";
import { FloatingControls } from "./FloatingControls";
import { QuantumFieldBackdrop } from "./backdrop/QuantumFieldBackdrop";
import { RadioProvider } from "./RadioContext";
import { routes } from "./routes";
import { ServiceBanner } from "./ServiceBanner";
import { TitleBar } from "./TitleBar";

const isKaraoke = (pathname: string): boolean => pathname.startsWith("/karaoke/");

export const AppShell = () => {
  const { pathname } = useLocation();
  const isLibrary = pathname === routes.library;

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
      void desktopClient.isFullscreen().then(active => active && desktopClient.toggleFullscreen());
    };
  }, [pathname]);

  return (
    <RadioProvider libraryActive={isLibrary}>
      <div className="app">
        <QuantumFieldBackdrop />
        <TitleBar />
        <div className="routeSurface">
          <ServiceBanner />
          <Outlet />
        </div>
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
