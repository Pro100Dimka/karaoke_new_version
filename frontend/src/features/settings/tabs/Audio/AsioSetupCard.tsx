import { useCallback, useEffect, useState } from "react";
import { Button, Card } from "@ad-voice/ui";
import type { DeviceDto } from "../../../../contracts/models";
import { useText } from "../../../../i18n/useText";
import { audioClient } from "../../../../services/audioClient";
import { desktopClient } from "../../../../services/desktopClient";

type SetupState = "idle" | "downloading" | "launched" | "ready" | "failed";

/**
 * Guides ASIO4ALL setup: install it, wait until the driver shows up, then restart the app —
 * or open the driver's own panel when it is already there.
 */
export const AsioSetupCard = ({ hasAsio4All, readyToRestart, onAsioDriverDetected, onOpenAsioControlPanel }: {
  hasAsio4All: boolean;
  readyToRestart: boolean;
  onAsioDriverDetected(device: DeviceDto): void;
  onOpenAsioControlPanel(): void;
}) => {
  const t = useText();
  const [state, setState] = useState<SetupState>("idle");
  const [error, setError] = useState("");
  const ready = readyToRestart || state === "ready";

  const detect = useCallback(async () => {
    const drivers = (await audioClient.listDevices()).filter(device => device.backend === "ASIO");
    const driver = drivers.find(device => /asio4all/i.test(device.name)) ?? drivers[0];
    if (!driver) return;
    onAsioDriverDetected(driver);
    setState("ready");
  }, [onAsioDriverDetected]);

  useEffect(() => {
    if (state !== "launched") return;
    const timer = window.setInterval(() => void detect().catch(() => undefined), 1500);
    return () => window.clearInterval(timer);
  }, [state, detect]);

  const install = async () => {
    setState("downloading");
    setError("");
    try {
      await desktopClient.installAsio4All();
      setState("launched");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setState("failed");
    }
  };

  const message = () => {
    if (ready) return t("asioSetupReady");
    if (state === "launched") return t("asioSetupLaunched");
    if (state === "failed") return t("asioSetupFailed", { reason: error });
    return t(hasAsio4All ? "asioSetupConfigureBody" : "asioSetupBody");
  };
  const action = () => {
    if (ready)
      return <Button size="sm" variant="primary" icon="reset" onClick={() => void desktopClient.relaunchApp()}>{t("asioSetupRestart")}</Button>;
    if (state === "launched")
      return <Button size="sm" icon="refresh" onClick={() => void detect()}>{t("asioSetupCheck")}</Button>;
    if (hasAsio4All)
      return <Button size="sm" icon="sliders" onClick={onOpenAsioControlPanel}>{t("asioSetupConfigure")}</Button>;
    return (
      <Button size="sm" variant="primary" icon="download" loading={state === "downloading"} onClick={() => void install()}>
        {t(state === "downloading" ? "asioSetupDownloading" : "asioSetupInstall")}
      </Button>
    );
  };

  return (
    <Card border role="region" aria-label="ASIO4ALL" icon="audio"
      title={t(hasAsio4All ? "asioSetupConfigureTitle" : "asioSetupTitle")} description={message()}
      actions={action()} />
  );
};
