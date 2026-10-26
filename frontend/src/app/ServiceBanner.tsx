import { Button, MessageBar, ProgressBar, tr } from "@neo-ui-kit/react";
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { routes } from "../shared/routes";
import { useNotify } from "./NotificationsProvider";
import { desktopClient } from "../services/desktopClient";
import {
  updateDownload,
  useUpdateAvailable,
  useUpdateDownload,
  useUpdateReady,
} from "./desktop/shellBus";
import { useServices } from "./ServicesContext";
import { useApp } from "./AppContext";

const notices = [
  {
    service: "python",
    kind: "unavailable",
    message: "Python Backend недоступен. Переподключение… Действия библиотеки отключены до его возврата.",
    tone: "error",
  },
  {
    service: "python",
    kind: "incompatible",
    message: "Протокол Python Backend несовместим",
    tone: "error",
  },
  {
    service: "audio",
    kind: "unavailable",
    message: "AudioService недоступен. Воспроизведение, мониторинг, запись и звук комнаты отключены.",
    tone: "warning",
  },
  {
    service: "audio",
    kind: "incompatible",
    message: "Протокол AudioService несовместим",
    tone: "error",
  },
] as const;

/** Non-blocking service notices and update progress on every screen. */
export const ServiceBanner = () => {
  useApp("language");
  const services = useServices();
  const update = useUpdateReady();
  const available = useUpdateAvailable();
  const download = useUpdateDownload();
  const { pathname } = useLocation();
  const notify = useNotify();
  const [dismissed, setDismissed] = useState(false);
  const [installing, setInstalling] = useState(false);
  const downloading = typeof download === "number";
  const version = update ?? available;
  const downloadLabel = downloading && version
    ? tr("Скачивание A&D Voice {version} — {percent}%", { version, percent: download })
    : undefined;

  useEffect(() => {
    if (download === null) setInstalling(false);
    if (download !== "failed") return;
    setInstalling(false);
    updateDownload.set(null);
    notify(tr("Не удалось скачать обновление. Попробуйте позже."), "error");
  }, [download, notify]);

  const install = () => {
    setInstalling(true);
    void desktopClient.installUpdate()
      .then((started) => started || setInstalling(false))
      .catch(() => updateDownload.set("failed"))
      .finally(() => setInstalling(false));
  };

  return (
    <div className="serviceBanners">
      {notices
        .filter(({ service, kind }) => services[service].kind === kind)
        .map(({ service, message, tone }) => (
          <MessageBar key={service} tone={tone}>
            {tr(message)}
          </MessageBar>
        ))}
      {version && (downloading || update || (!dismissed && pathname === routes.library)) && (
        <MessageBar
          tone="info"
          action={
            !downloading && (
              <>
                {!update && (
                  <Button size="sm" variant="ghost" disabled={installing} onClick={() => setDismissed(true)}>
                    {tr("Отклонить")}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="primary"
                  icon={update ? "refresh" : "download"}
                  loading={installing}
                  onClick={install}
                >
                  {update ? tr("Обновить сейчас") : tr("Установить")}
                </Button>
              </>
            )
          }
        >
          {downloading ? (
            <div style={{ display: "grid", gap: "0.375rem" }}>
              <span>{downloadLabel}</span>
              <ProgressBar value={download} max={100} label={downloadLabel} />
            </div>
          ) : update ? (
            tr("A&D Voice {version} скачано и установится при следующем запуске", { version })
          ) : (
            tr("Доступно обновление A&D Voice {version}", { version })
          )}
        </MessageBar>
      )}
    </div>
  );
};
