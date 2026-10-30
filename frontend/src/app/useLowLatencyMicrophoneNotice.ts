import { tr, useLocale } from "@neo-ui-kit/react";
import { ru } from "../i18n/messages.ru";
import { useEffect, useRef } from "react";
import { audioClient } from "../services/audioClient";
import { useNotify } from "../providers/notifications";

/** A short, unobtrusive note when "minimum microphone latency" could not take effect. */
export const useLowLatencyMicrophoneNotice = (): void => {
  const notify = useNotify();
  useLocale();
  const tools = useRef({ notify });
  tools.current = { notify };
  useEffect(
    () =>
      audioClient.onLowLatencyMicrophoneFallback(({ microphoneAvailable }) =>
        tools.current.notify(
          tr(
            ru[microphoneAvailable ? "lowLatencyMicrophoneFallback" : "microphoneHeldByAnotherApp"],
          ),
          microphoneAvailable ? "info" : "warning",
        ),
      ),
    [],
  );
};
