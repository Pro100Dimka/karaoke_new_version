import { MessageBar } from "@ad-voice/ui";
import { useText } from "../i18n/useText";
import { useServices } from "./ServicesContext";

/** Non-blocking, per-subsystem notices so one failed service is not presented as an app-wide crash. */
export const ServiceBanner = () => {
  const { python, audio } = useServices();
  const t = useText();

  return (
    <div className="serviceBanners">
      {python.kind === "unavailable" && <MessageBar tone="error">{t("pythonReconnecting")}</MessageBar>}
      {python.kind === "incompatible" && <MessageBar tone="error">{t("pythonIncompatible")}</MessageBar>}
      {audio.kind === "unavailable" && <MessageBar tone="warning">{t("audioServiceUnavailable")}</MessageBar>}
      {audio.kind === "incompatible" && <MessageBar tone="error">{t("audioIncompatible")}</MessageBar>}
    </div>
  );
};
