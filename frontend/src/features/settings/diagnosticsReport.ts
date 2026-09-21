import type { BackendDiagnosticsDto } from "../../contracts/models";

export interface DiagnosticsSnapshot {
  frontendVersion: string;
  generatedAt: string;
  backend: BackendDiagnosticsDto | null;
  audio: Readonly<Record<string, string>> | null;
  keyboardLighting: boolean;
}

/** Technical snapshot only; it never contains song audio, lyrics or recordings. */
export const buildDiagnosticsReport = (snapshot: DiagnosticsSnapshot): string =>
  JSON.stringify(
    {
      application: { name: "A&D Voice", frontendVersion: snapshot.frontendVersion, generatedAt: snapshot.generatedAt },
      pythonBackend: snapshot.backend ?? "unavailable",
      audioService: snapshot.audio ?? "unavailable",
      keyboardLighting: snapshot.keyboardLighting ? "supported" : "unsupported: no compatible device"
    },
    null,
    2
  );
