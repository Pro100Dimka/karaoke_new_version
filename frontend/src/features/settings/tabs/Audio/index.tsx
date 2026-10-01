import type { FormikProps } from "formik";
import { AudioWaveform, Download, RefreshCw, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type {
  AudioCapabilities,
  AudioConfigurationCapabilities,
  DeviceDto,
  RuntimeAudioConfiguration,
} from "../../../../contracts/models";
import type { MessageKey } from "../../../../i18n/messages";
import { useText } from "../../../../i18n/useText";
import { desktopClient } from "../../../../services/desktopClient";
import { audioClient } from "../../../../services/audioClient";
import { Alert } from "../../../../shared/ui/Alert";
import { Button, RenderFormikFields } from "../../../../theme/ui";
import { AudioSection } from "./AudioSection";
import type { AudioValues } from "./settingsModel";
import { audioRows } from "./audioRows";
import { AudioTests } from "./AudioTests";
import "./audio.css";

const microphoneMessage = {
  ready: "microphoneReady",
  "permission-denied": "microphonePermissionDenied",
  "privacy-disabled": "microphonePrivacyDisabled",
  missing: "microphoneMissing",
  busy: "microphoneBusy",
} as const satisfies Record<AudioCapabilities["microphone"], MessageKey>;

export const AudioSettings = ({
  formik,
  runtime,
  devices,
  capabilities,
  configurationCapabilities,
  audioAvailable,
  inputLevel,
  testingInput,
  onToggleInputTest,
  onPlayTestSound,
  onAudioCommit,
  asioUnavailable = false,
  asioReadyToRestart = false,
  onAsioDriverDetected,
}: {
  formik: FormikProps<AudioValues>;
  runtime: RuntimeAudioConfiguration;
  devices: readonly DeviceDto[];
  capabilities: AudioCapabilities;
  configurationCapabilities: AudioConfigurationCapabilities;
  audioAvailable: boolean;
  inputLevel: number;
  testingInput: boolean;
  onToggleInputTest(enabled: boolean): void;
  onPlayTestSound(): void;
  asioUnavailable?: boolean;
  asioReadyToRestart?: boolean;
  onAsioDriverDetected(device: DeviceDto): void;
  /** Called with every committed field so the new configuration is applied at once. */
  onAudioCommit(name: string, value: unknown): void;
}) => {
  const t = useText();
  const microphoneIssue = capabilities.microphone !== "ready";
  const privacyIssue = ["permission-denied", "privacy-disabled"].includes(
    capabilities.microphone,
  );
  const hasAsioDriver = devices.some(device => device.backend === "ASIO");
  const [asioSetupState, setAsioSetupState] = useState<"idle" | "downloading" | "launched" | "ready" | "failed">("idle");
  const [asioSetupError, setAsioSetupError] = useState("");
  const setupReady = asioReadyToRestart || asioSetupState === "ready";
  const showAsioSetup = formik.values.backend === "ASIO"
    && (asioUnavailable || !hasAsioDriver || setupReady);

  const detectAsioDriver = useCallback(async () => {
    const asioDrivers = (await audioClient.listDevices()).filter(device => device.backend === "ASIO");
    const driver = asioDrivers.find(device => /asio4all/i.test(device.name)) ?? asioDrivers[0];
    if (!driver) return false;
    onAsioDriverDetected(driver);
    setAsioSetupState("ready");
    return true;
  }, [onAsioDriverDetected]);

  useEffect(() => {
    if (asioSetupState !== "launched") return;
    const timer = window.setInterval(() => void detectAsioDriver().catch(() => undefined), 1500);
    return () => window.clearInterval(timer);
  }, [asioSetupState, detectAsioDriver]);

  const installAsio4All = async () => {
    setAsioSetupState("downloading");
    setAsioSetupError("");
    try {
      await desktopClient.installAsio4All();
      setAsioSetupState("launched");
    } catch (error) {
      setAsioSetupError(error instanceof Error ? error.message : String(error));
      setAsioSetupState("failed");
    }
  };

  return (
    <div className="audioSettings audioStack">
      <AudioSection
        icon={AudioWaveform}
        title={t("audioDevicesTitle")}
        hint={t("audioDevicesHint")}
        className="audioDevicesCard"
      >
        {!audioAvailable && (
          <Alert intent="error">{t("audioServiceUnavailable")}</Alert>
        )}
        <RenderFormikFields
          formik={formik}
          items={audioRows(
            t,
            formik.values,
            runtime,
            devices,
            audioAvailable,
            onPlayTestSound,
            configurationCapabilities,
          )}
          onFieldCommit={onAudioCommit}
        />
        {microphoneIssue && (
          <Alert
            intent="warning"
            actions={
              privacyIssue ? (
                <Button
                  size="sm"
                  onClick={() => void desktopClient.openMicrophonePrivacy()}
                >
                  {t("openMicrophonePrivacy")}
                </Button>
              ) : undefined
            }
          >
            {t(microphoneMessage[capabilities.microphone])}
          </Alert>
        )}
      </AudioSection>
      {showAsioSetup && (
        <section className="asioSetupCard" role="region" aria-label="ASIO4ALL">
          <div className="asioSetupCopy">
            <strong>{t("asioSetupTitle")}</strong>
            <span>{setupReady ? t("asioSetupReady")
              : asioSetupState === "launched" ? t("asioSetupLaunched")
              : asioSetupState === "failed" ? t("asioSetupFailed", { reason: asioSetupError })
              : t("asioSetupBody")}</span>
          </div>
          <div className="asioSetupActions">
            {setupReady ? (
              <Button size="sm" onClick={() => void desktopClient.relaunchApp()}>
                <RotateCcw size={16} />{t("asioSetupRestart")}
              </Button>
            ) : asioSetupState === "launched" ? (
              <Button size="sm" tone="neutral" onClick={() => void detectAsioDriver()}>
                <RefreshCw size={16} />{t("asioSetupCheck")}
              </Button>
            ) : (
              <>
                <Button size="sm" disabled={asioSetupState === "downloading"} onClick={() => void installAsio4All()}>
                  <Download size={16} />{asioSetupState === "downloading" ? t("asioSetupDownloading") : t("asioSetupInstall")}
                </Button>
              </>
            )}
          </div>
        </section>
      )}
      <AudioTests
        runtime={runtime}
        audioAvailable={audioAvailable}
        microphoneIssue={microphoneIssue}
        inputLevel={inputLevel}
        testingInput={testingInput}
        onToggleInputTest={onToggleInputTest}
        onPlayTestSound={onPlayTestSound}
      />
    </div>
  );
};
