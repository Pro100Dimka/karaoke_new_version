import { Button, MessageBar } from "@neo-ui-kit/react";
import { useState } from "react";
import { useText } from "../i18n/useText";
import { desktopClient } from "../services/desktopClient";
import { useUpdateReady } from "./desktop/shellBus";
import { useServices } from "./ServicesContext";

const notices = [
  {
    service: "python",
    kind: "unavailable",
    message: "pythonReconnecting",
    tone: "error",
  },
  {
    service: "python",
    kind: "incompatible",
    message: "pythonIncompatible",
    tone: "error",
  },
  {
    service: "audio",
    kind: "unavailable",
    message: "audioServiceUnavailable",
    tone: "warning",
  },
  {
    service: "audio",
    kind: "incompatible",
    message: "audioIncompatible",
    tone: "error",
  },
] as const;

/** Non-blocking, per-subsystem notices so one failed service is not presented as an app-wide crash. */
export const ServiceBanner = () => {
  const services = useServices();
  const t = useText();
  const update = useUpdateReady();
  const [installing, setInstalling] = useState(false);

  return (
    <div className="serviceBanners">
      {notices
        .filter(({ service, kind }) => services[service].kind === kind)
        .map(({ service, message, tone }) => (
          <MessageBar key={service} tone={tone}>
            {t(message)}
          </MessageBar>
        ))}
      {update && (
        <MessageBar
          tone="info"
          action={
            <Button
              size="sm"
              variant="primary"
              icon="refresh"
              loading={installing}
              onClick={() => {
                setInstalling(true);
                void desktopClient.installUpdate().then((started) => started || setInstalling(false));
              }}
            >
              {t("restartToUpdate")}
            </Button>
          }
        >
          {t("updateDownloaded", { version: update })}
        </MessageBar>
      )}
    </div>
  );
};
