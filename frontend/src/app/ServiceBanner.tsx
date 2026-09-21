import { useText } from "../i18n/useText";
import { Alert } from "../shared/ui/Alert";
import { useServices } from "./ServicesContext";

/** Non-blocking, per-subsystem notices so one failed service is not presented as an app-wide crash. */
export const ServiceBanner = () => {
  const { python, audio } = useServices();
  const t = useText();

  return (
    <div className="serviceBanners">
      {python.kind === "unavailable" && <Alert intent="error">{t("pythonReconnecting")}</Alert>}
      {python.kind === "incompatible" && <Alert intent="error">{t("pythonIncompatible")}</Alert>}
      {audio.kind === "unavailable" && <Alert intent="warning">{t("audioServiceUnavailable")}</Alert>}
      {audio.kind === "incompatible" && <Alert intent="error">{t("audioIncompatible")}</Alert>}
    </div>
  );
};
