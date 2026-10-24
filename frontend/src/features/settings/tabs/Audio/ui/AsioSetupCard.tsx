import { Button, Card } from "@neo-ui-kit/react";
import type { DeviceDto } from "../../../../../contracts/models";
import { useText } from "../../../../../i18n/useText";
import { useAsioSetup } from "../hooks/useAsioSetup";

/** Guides installation, driver detection and the restart after preferences are saved. */
export const AsioSetupCard = ({
  hasAsio4All,
  readyToRestart,
  onAsioDriverDetected,
  onOpenAsioControlPanel,
}: {
  hasAsio4All: boolean;
  readyToRestart: boolean;
  onAsioDriverDetected(device: DeviceDto): void;
  onOpenAsioControlPanel(): void;
}) => {
  const t = useText();
  const setup = useAsioSetup(onAsioDriverDetected);
  // Finding a driver does not prove its preference was successfully saved.
  const ready = readyToRestart;
  const message = () => {
    if (setup.error) return t("asioSetupFailed", { reason: setup.error });
    if (ready) return t("asioSetupReady");
    if (setup.phase === "launched" || setup.phase === "detected")
      return t("asioSetupLaunched");
    if (setup.phase === "failed")
      return t("asioSetupFailed", { reason: setup.error ?? "" });
    return t(hasAsio4All ? "asioSetupConfigureBody" : "asioSetupBody");
  };
  const action = () => {
    if (ready)
      return (
        <Button
          size="sm"
          variant="primary"
          icon="reset"
          onClick={() => void setup.restart()}
        >
          {t("asioSetupRestart")}
        </Button>
      );
    if (setup.phase === "launched" || setup.phase === "detected")
      return (
        <Button size="sm" icon="refresh" onClick={() => void setup.detect()}>
          {t("asioSetupCheck")}
        </Button>
      );
    if (hasAsio4All)
      return (
        <Button size="sm" icon="sliders" onClick={onOpenAsioControlPanel}>
          {t("asioSetupConfigure")}
        </Button>
      );
    return (
      <Button
        size="sm"
        variant="primary"
        icon="download"
        loading={setup.phase === "downloading"}
        onClick={() => void setup.install()}
      >
        {t(
          setup.phase === "downloading"
            ? "asioSetupDownloading"
            : "asioSetupInstall",
        )}
      </Button>
    );
  };

  return (
    <Card
      border
      role="region"
      aria-label="ASIO4ALL"
      icon="audio"
      title={t(hasAsio4All ? "asioSetupConfigureTitle" : "asioSetupTitle")}
      description={message()}
      actions={action()}
    />
  );
};
