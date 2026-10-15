import { useEffect, useRef } from "react";
import { audioClient } from "../services/audioClient";
import { useText } from "../i18n/useText";
import { useNotify } from "./NotificationsProvider";

/** A short, unobtrusive note when "minimum microphone latency" could not take effect. */
export const useLowLatencyMicrophoneNotice = (): void => {
  const notify = useNotify();
  const t = useText();
  const tools = useRef({ notify, t });
  tools.current = { notify, t };
  useEffect(
    () =>
      audioClient.onLowLatencyMicrophoneFallback(({ microphoneAvailable }) =>
        tools.current.notify(
          tools.current.t(
            microphoneAvailable ? "lowLatencyMicrophoneFallback" : "microphoneHeldByAnotherApp",
          ),
          microphoneAvailable ? "info" : "warning",
        ),
      ),
    [],
  );
};
