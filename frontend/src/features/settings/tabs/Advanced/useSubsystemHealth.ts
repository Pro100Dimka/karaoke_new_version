import { useCallback, useEffect, useState } from "react";
import type { BackendDiagnosticsDto } from "../../../../contracts/models";
import { useSettingsAudio, useSettingsBackend } from "../../../../app/SettingsProvider";

export interface SubsystemHealth {
  loading: boolean;
  backend: BackendDiagnosticsDto | null;
  audio: Readonly<Record<string, string>> | null;
  audioVersion: string;
  refresh(): void;
}

/** Python and AudioService are probed independently so one failure is never shown as an app-wide crash. */
export const useSubsystemHealth = (): SubsystemHealth => {
  const audio = useSettingsAudio();
  const backend = useSettingsBackend();
  const [state, setState] = useState<Omit<SubsystemHealth, "refresh">>({
    loading: true,
    backend: null,
    audio: null,
    audioVersion: "",
  });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let active = true;
    void Promise.all([
      backend.diagnostics().catch(() => null),
      audio.diagnosticsDump().catch(() => null),
      audio.health().catch(() => null),
    ]).then(([backend, audio, health]) => {
      if (active)
        setState({
          loading: false,
          backend,
          audio,
          audioVersion: health?.version ?? "",
        });
    });
    return () => {
      active = false;
    };
  }, [generation]);

  const refresh = useCallback(() => setGeneration((value) => value + 1), []);
  return { ...state, refresh };
};
