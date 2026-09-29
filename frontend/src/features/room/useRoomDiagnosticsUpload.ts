import { useEffect } from "react";
import { audioClient } from "../../services/audioClient";
import { roomClient } from "../../services/roomClient";

// Often enough to follow a song; small enough that a room of four stays well under a kilobyte a second.
const uploadMilliseconds = 5_000;

/**
 * While this computer is in a room, its audio diagnostics (numbers only: latencies, packets, device
 * mode) go to the room server, so every computer of the room can be compared over time without the
 * participants copying reports by hand.
 */
export const useRoomDiagnosticsUpload = (code: string | undefined): void => {
  useEffect(() => {
    if (!code) return;
    let active = true;
    let uploading = false;
    const upload = async () => {
      if (uploading) return;
      uploading = true;
      try {
        const values = await audioClient.diagnosticsDump();
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
