// Temporary: renders the room panel with the reference's sample data for side-by-side comparison.
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import "./theme/ui";
import "./styles.css";
import { storageKey, writeJson } from "./shared/storage/localStore";

writeJson(storageKey("panelLayout.room"), { left: 13, top: 17.5, width: 555, height: 640 });
let tick = 0;
const diagnostics = () => {
  tick += 1;
  const delay = 3264 + Math.round(Math.sin(tick * 1.7) * 380 + Math.sin(tick * 0.6) * 250);
  return [
    "RuntimeOutputSampleRate: 48000", `RoomCompensationFrames: ${delay}`, "NetworkRoundTripMs: 20",
    "RemoteJitterMs.guest: 1.2", "RemoteTargetDelayFrames.guest: 1264", "RemoteDirectFirstPackets.guest: 900",
  ].join("\n");
};
const handlers: Record<string, unknown> = {
  pythonRequest: async (request: { path: string }) => request.path.startsWith("/songs?")
    ? { ok: true, status: 200, body: { items: [{
      songId: "song", title: "Reference Song", artist: "Reference Artist", album: null,
      artworkUrl: "/src/assets/karaoke-backgrounds/dark.webp", duration: 180,
      language: "Auto", status: "Ready", activeRevision: 1, projectFormatVersion: 1,
      coverState: "Custom", createdAt: "2026-01-01T00:00:00.000Z",
    }], nextCursor: null } }
    : { ok: false, status: 404, body: {} },
  audioRequest: async (request: { command: string; enabled?: boolean }) =>
    request.command === "SetMonitoring" ? { status: 0, text: "" } : { status: 0, text: diagnostics() },
  socialLatest: async () => ({ type: "offline" }),
};
(window as unknown as { desktop: unknown }).desktop = new Proxy(handlers, {
  get: (target, key: string) => key in target ? target[key] : key.startsWith("on") ? () => () => undefined : async () => null,
});

const { AppProvider, useApp } = await import("./app/AppContext");
const { NotificationsProvider } = await import("./app/NotificationsProvider");
const { DialogProvider } = await import("./app/DialogProvider");
const { RoomDock } = await import("./features/room/RoomDock");

const InRoom = () => {
  const { setRoom, updatePreferences } = useApp();
  useEffect(() => {
    updatePreferences({ voiceGain: 0.72, theme: "dark", language: "ru" });
    setRoom({
      code: "a689365a-6315-4f8a-9080-3a4236f8ca04", hostId: "host", role: "host", playbackLocked: false,
      songId: "song", revision: 1, transferProgress: 70, transferId: "transfer",
      sharedSongs: [{ ownerParticipantId: "host", songId: "song", revision: 1,
        title: "Reference Song", artist: "Reference Artist", durationSeconds: 180 }],
      participants: [
        { id: "host", name: "Release Host", role: "host", self: true, connected: true, muted: false, speakingLevel: 0.2, volume: 1, readiness: "ready" },
        { id: "guest", name: "Release Guest", role: "participant", self: false, connected: true, muted: false, speakingLevel: 0.15, volume: 1, readiness: "downloading" },
      ],
    } as never);
  }, []);
  return null;
};

createRoot(document.getElementById("root") as HTMLElement).render(
  <AppProvider><NotificationsProvider><DialogProvider><MemoryRouter>
    <InRoom />
    <RoomDock />
  </MemoryRouter></DialogProvider></NotificationsProvider></AppProvider>,
);
