import { useEffect, useRef } from "react";
import { useApp } from "../../app/AppContext";
import { audioClient } from "../../services/audioClient";
import { roomClient } from "../../services/roomClient";
import { acousticLatencyKey } from "../../shared/preferences/preferences";

// Often enough to follow a song; small enough that a room of four stays well under a kilobyte a second.
const uploadMilliseconds = 5_000;

/**
 * While this computer is in a room, its audio diagnostics (numbers only: latencies, packets, device
 * mode, and the names of the chosen devices) go to the room server, so every computer of the room
 * can be compared over time without the participants copying reports by hand.
 */
export const useRoomDiagnosticsUpload = (code: string | undefined): void => {
  const { preferences } = useApp();
  const audio = useRef(preferences);
  audio.current = preferences;
  useEffect(() => {
    if (!code) return;
    let active = true;
    let uploading = false;
    let deviceNames: ReadonlyMap<string, string> | undefined;
    const upload = async () => {
      if (uploading) return;
      uploading = true;
      try {
        deviceNames ??= new Map((await audioClient.listDevices()).map(device => [device.id, device.name]));
        const { audio: requested, acousticLatencyMs } = audio.current;
        const values = {
          ...await audioClient.diagnosticsDump(),
          "App.InputDevice": deviceNames.get(requested.inputDeviceId ?? "") ?? "default",
          "App.OutputDevice": deviceNames.get(requested.outputDeviceId ?? "") ?? "default",
          "App.HiddenLatencyMs": String(acousticLatencyMs[acousticLatencyKey(requested)] ?? "unmeasured"),
        };
        if (active) await roomClient.publishDiagnostics(code, values);
      } catch {
        // Diagnostics are best effort; the next interval tries again.
      } finally {
        uploading = false;
      }
    };
    const timer = window.setInterval(() => void upload(), uploadMilliseconds);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [code]);
};
