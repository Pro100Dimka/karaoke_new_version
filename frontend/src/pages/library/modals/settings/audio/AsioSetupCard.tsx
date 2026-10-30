import { Button, Card, tr, useLocale } from "@neo-ui-kit/react";
import type { DeviceDto } from "../../../../../contracts/models";
import { ru } from "../../../../../i18n/messages.ru";
import { useAsioSetup } from "./useAsioSetup";

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
  useLocale();
  const setup = useAsioSetup(onAsioDriverDetected);
  // Finding a driver does not prove its preference was successfully saved.
  const ready = readyToRestart;
  const message = () => {
    if (setup.error) return tr(ru.asioSetupFailed, { reason: setup.error });
    if (ready) return tr(ru.asioSetupReady);
    if (setup.phase === "launched" || setup.phase === "detected")
      return tr(ru.asioSetupLaunched);
    if (setup.phase === "failed")
      return tr(ru.asioSetupFailed, { reason: setup.error ?? "" });
    return tr(ru[hasAsio4All ? "asioSetupConfigureBody" : "asioSetupBody"]);
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
          {tr(ru.asioSetupRestart)}
        </Button>
      );
    if (setup.phase === "launched" || setup.phase === "detected")
      return (
        <Button size="sm" icon="refresh" onClick={() => void setup.detect()}>
          {tr(ru.asioSetupCheck)}
        </Button>
      );
    if (hasAsio4All)
      return (
        <Button size="sm" icon="sliders" onClick={onOpenAsioControlPanel}>
          {tr(ru.asioSetupConfigure)}
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
        {tr(
          ru[setup.phase === "downloading"
            ? "asioSetupDownloading"
            : "asioSetupInstall"],
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
      title={tr(ru[hasAsio4All ? "asioSetupConfigureTitle" : "asioSetupTitle"])}
      description={message()}
      actions={action()}
    />
  );
};
