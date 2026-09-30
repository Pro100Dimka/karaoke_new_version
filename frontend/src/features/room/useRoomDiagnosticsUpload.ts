import { useEffect, useRef } from "react";
import { useApp } from "../../app/AppContext";
import { audioClient } from "../../services/audioClient";
import { roomClient } from "../../services/roomClient";

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
        const { audio: requested } = audio.current;
        const diagnosticValues = await audioClient.diagnosticsDump();
        const acousticMicroseconds = Number(diagnosticValues.AcousticLatencyUs);
        const currentLatency = diagnosticValues.AcousticCalibrationValid === "1"
          && Number.isFinite(acousticMicroseconds) && acousticMicroseconds >= 0
          && acousticMicroseconds <= 500_000
          ? String(acousticMicroseconds / 1000) : "unmeasured";
        const values = {
          ...diagnosticValues,
          "App.InputDevice": deviceNames.get(requested.inputDeviceId ?? "") ?? "default",
          "App.OutputDevice": deviceNames.get(requested.outputDeviceId ?? "") ?? "default",
          // The mode chosen in the settings, beside the mode AudioService actually runs ("Backend").
          "App.RequestedBackend": requested.backend,
          "App.HiddenLatencyMs": currentLatency,
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
