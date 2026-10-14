import { Button, MessageBar } from "@neo-ui-kit/react";
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { routes } from "../shared/routes";
import { useNotify } from "./NotificationsProvider";
import { useText } from "../i18n/useText";
import { desktopClient } from "../services/desktopClient";
import {
  updateDownload,
  useUpdateAvailable,
  useUpdateDownload,
  useUpdateReady,
} from "./desktop/shellBus";
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

/**
 * With updates off, a newer version is offered in the Library at start-up: "Install" downloads it
 * (with its progress here), installs it and opens the new version; "Dismiss" hides it until the
 * next start.
 */
const useOfferedUpdate = () => {
  const version = useUpdateAvailable();
  const download = useUpdateDownload();
  const { pathname } = useLocation();
  const notify = useNotify();
  const t = useText();
  const [dismissed, setDismissed] = useState(false);
  const [requested, setRequested] = useState(false);
  useEffect(() => {
    if (download !== "failed") return;
    setRequested(false);
    updateDownload.set(null);
    notify(t("updateInstallFailed"), "error");
  }, [download, notify, t]);
  const downloading = requested && download !== "failed";
  return {
    version,
    shown: Boolean(version) && !dismissed && (pathname === routes.library || downloading),
    downloading,
    percent: downloading && typeof download === "number" ? download : null,
    dismiss: () => setDismissed(true),
    install: () => {
      setRequested(true);
      void desktopClient.installUpdate().then((started) => started || setRequested(false));
    },
  };
};

/** Non-blocking, per-subsystem notices so one failed service is not presented as an app-wide crash. */
export const ServiceBanner = () => {
  const services = useServices();
  const t = useText();
  const update = useUpdateReady();
  const [installing, setInstalling] = useState(false);
  const offer = useOfferedUpdate();

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
      {offer.shown && (
        <MessageBar
          tone="info"
          action={
            <>
              <Button size="sm" variant="ghost" disabled={offer.downloading} onClick={offer.dismiss}>
                {t("updateDismiss")}
              </Button>
              <Button
                size="sm"
                variant="primary"
                icon="download"
                loading={offer.downloading}
                onClick={offer.install}
              >
                {t("updateInstall")}
              </Button>
            </>
          }
        >
          {offer.percent === null
            ? t("updateAvailable", { version: offer.version ?? "" })
            : t("updateDownloadingPercent", { percent: offer.percent })}
        </MessageBar>
      )}
    </div>
  );
};
