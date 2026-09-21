import { useCallback, useEffect, useState } from "react";
import type { BackendDiagnosticsDto } from "../../contracts/models";
import { audioClient } from "../../services/audioClient";
import { pythonClient } from "../../services/pythonClient";

export interface SubsystemHealth {
  loading: boolean;
  backend: BackendDiagnosticsDto | null;
  audio: Readonly<Record<string, string>> | null;
  audioVersion: string;
  refresh(): void;
}

/** Python and AudioService are probed independently so one failure is never shown as an app-wide crash. */
export const useSubsystemHealth = (): SubsystemHealth => {
  const [state, setState] = useState<Omit<SubsystemHealth, "refresh">>({
    loading: true,
    backend: null,
    audio: null,
    audioVersion: ""
  });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let active = true;
    void Promise.all([
      pythonClient.diagnostics().catch(() => null),
      audioClient.diagnosticsDump().catch(() => null),
      audioClient.health().catch(() => null)
    ]).then(([backend, audio, health]) => {
      if (active) setState({ loading: false, backend, audio, audioVersion: health?.version ?? "" });
    });
    return () => {
      active = false;
    };
  }, [generation]);

  const refresh = useCallback(() => setGeneration(value => value + 1), []);
  return { ...state, refresh };
};
