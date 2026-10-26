import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useText } from "../../i18n/useText";
import { desktopClient } from "../../services/desktopClient";
import { routes } from "../../shared/routes";
import { useApp, useRoomVoice } from "../AppContext";
import { useNotify } from "../NotificationsProvider";
import { useRadio } from "../RadioContext";
import { radioStations } from "../radioStations";
import {
  libraryCommands,
  microphoneToggled,
  nowPlaying,
  onBattery,
  updateReady,
  updateAvailable,
  updateDownload,
  radioTrack,
  useRadioTrack,
  displayCount,
  useKaraokeOnTv,
  useMicrophoneToggles,
  useNowPlaying,
  type LibraryCommand,
} from "./shellBus";

const screenOf = (pathname: string) =>
  pathname === routes.library
    ? "library"
    : pathname.startsWith("/karaoke/")
      ? "karaoke"
      : pathname.startsWith("/editor/")
        ? "editor"
        : "other";

const isCommand = (value: unknown): value is { type: string } & Record<string, unknown> =>
  !!value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string";

/**
 * Connects the interface to the desktop: tells it what is happening (for the taskbar, tray and
 * Discord) and carries out what the desktop asks (taskbar buttons, tray, jump list, invitation
 * links, the mute hotkey, files opened with the app, power changes). Renders nothing.
 */
export const DesktopShellBridge = () => {
  const t = useText();
  const notify = useNotify();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const screen = screenOf(pathname);
  const playing = useNowPlaying();
  // A song on the TV is shown and driven from the taskbar and tray while the laptop is in the Library.
  const onTv = useKaraokeOnTv();
  const singing = screen === "karaoke" || onTv;
  const radio = useRadio();
  const { room } = useApp("room");
  const { language } = useApp("language");
  const { preferences } = useApp("preferences");
  const voice = useRoomVoice();
  const toggles = useMicrophoneToggles();
  // The microphone's switch lives in AudioService; it is re-read on changes and checked now and then
  // while in a room, so the taskbar and tray follow the room card's own mute button too.
  const [muted, setMuted] = useState<boolean>();
  useEffect(() => {
    if (!room || !voice) return setMuted(undefined);
    const read = () => setMuted(!voice.microphoneEnabled());
    read();
    const timer = window.setInterval(read, 1000);
    return () => window.clearInterval(timer);
  }, [room, voice, toggles]);

  const stationEntry = radioStations.find((item) => item.id === radio.stationId);
  const station = stationEntry?.name;
  const streamUrl = stationEntry?.url;
  const track = useRadioTrack();
  const status = useMemo(
    () => ({
      language,
      screen,
      ...(singing && playing
        ? { song: { title: playing.title, artist: playing.artist } }
        : {}),
      playing: singing && playing?.playing === true,
      recording: singing && playing?.recording === true,
      ...(room ? { room: { code: room.code, participants: room.participants.length } } : {}),
      radio: {
        available: screen === "library" && !onTv && radio.canControl,
        enabled: radio.enabled,
        station,
        streamUrl,
        ...(track ? { track } : {}),
      },
      ...(room && muted !== undefined ? { microphoneMuted: muted } : {}),
      discordPresence: preferences.discordPresence,
      autoUpdate: preferences.autoUpdate,
    }),
    [language, screen, singing, onTv, playing, room, radio.canControl, radio.enabled, station, streamUrl, track, muted, preferences.discordPresence, preferences.autoUpdate],
  );
  useEffect(() => {
    void desktopClient.reportShellStatus(status).catch(() => undefined);
  }, [status]);

  // Commands read the latest values through a ref: the subscription stays put while they change.
  const latest = useRef({ screen, radio, voice, navigate, notify, t });
  latest.current = { screen, radio, voice, navigate, notify, t };
  useEffect(
    () =>
      desktopClient.onShellCommand((command) => {
        if (!isCommand(command)) return;
        const { screen, radio, voice, navigate, notify, t } = latest.current;
        // Library work never pulls a singer out of a song: it waits until they are back in the Library.
        const forLibrary = (next: LibraryCommand) => {
          libraryCommands.push(next);
          if (screen === "library") return;
          if (screen === "karaoke" || screen === "editor") notify(t("desktopActionWaitsForLibrary"), "info");
          else navigate(routes.library);
        };
        switch (command.type) {
          case "togglePlayback":
            nowPlaying.get()?.togglePlayback();
            break;
          case "toggleRadio":
            radio.toggle();
            break;
          case "nextStation": {
            const index = radioStations.findIndex((item) => item.id === radio.stationId);
            const next = radioStations[(index + 1) % radioStations.length];
            if (next) radio.setStation(next.id);
            break;
          }
          case "addSong":
            forLibrary({ type: "addSong" });
            break;
          case "openRoom":
            forLibrary({ type: "openRoom" });
            break;
          case "joinRoom":
            if (typeof command.code === "string") forLibrary({ type: "openRoom", code: command.code });
            break;
          case "importFiles":
            if (Array.isArray(command.paths))
              forLibrary({ type: "importFiles", paths: command.paths.filter((path): path is string => typeof path === "string") });
            break;
          case "toggleMicrophone":
            if (voice)
              void voice
                .setMicrophoneEnabled(!voice.microphoneEnabled())
                .then(() => microphoneToggled.set(microphoneToggled.get() + 1))
                .catch(() => undefined);
            break;
          case "power":
            onBattery.set(command.onBattery === true);
            break;
          case "updateReady":
            if (typeof command.version === "string") {
              updateDownload.set(null);
              updateAvailable.set(null);
              updateReady.set(command.version);
            }
            break;
          case "updateAvailable":
            if (typeof command.version === "string") updateAvailable.set(command.version);
            break;
          case "updateProgress":
            if (typeof command.percent === "number")
              updateDownload.set(Math.max(0, Math.min(100, Math.round(command.percent))));
            break;
          case "updateFailed":
            updateDownload.set("failed");
            break;
          case "radioTrack":
            radioTrack.set(
              typeof command.title === "string" && command.title
                ? { title: command.title, ...(typeof command.artist === "string" && command.artist ? { artist: command.artist } : {}) }
                : null,
            );
            break;
          case "displays":
            if (typeof command.count === "number") displayCount.set(Math.max(1, Math.round(command.count)));
            break;
        }
      }),
    [],
  );
  return null;
};
