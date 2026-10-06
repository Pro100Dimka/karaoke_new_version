import type { FormApi } from "@ad-voice/ui";
import { Button, Card, MessageBar } from "@ad-voice/ui";
import type {
  AudioCapabilities,
  AudioConfigurationCapabilities,
  DeviceDto,
  RuntimeAudioConfiguration,
} from "../../../../contracts/models";
import type { MessageKey } from "../../../../i18n/messages";
import { useText } from "../../../../i18n/useText";
import { desktopClient } from "../../../../services/desktopClient";
import "./audio.css";
import { AsioSetupCard } from "./AsioSetupCard";
import { AudioFields } from "./AudioFields";
import { audioRows } from "./audioRows";
import { AudioTests } from "./AudioTests";
import type { AudioValues } from "./settingsModel";

const microphoneMessage = {
  ready: "microphoneReady",
  "permission-denied": "microphonePermissionDenied",
  "privacy-disabled": "microphonePrivacyDisabled",
  missing: "microphoneMissing",
  busy: "microphoneBusy",
} as const satisfies Record<AudioCapabilities["microphone"], MessageKey>;
const privacyIssues = new Set<AudioCapabilities["microphone"]>([
  "permission-denied",
  "privacy-disabled",
]);

export interface AudioSettingsProps {
  form: FormApi<AudioValues>;
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
  onOpenAsioControlPanel(): void;
  releaseAsioInBackground: boolean;
  onReleaseAsioInBackgroundChange(value: boolean): void;
  /** Called with every committed field so the new configuration is applied at once. */
  onAudioCommit(name: string, value: unknown): void;
}

export const AudioSettings = ({
  form,
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
  onOpenAsioControlPanel,
  releaseAsioInBackground,
  onReleaseAsioInBackgroundChange,
}: AudioSettingsProps) => {
  const t = useText();
  const microphoneIssue = capabilities.microphone !== "ready";
  const hasAsioDriver = devices.some((device) => device.backend === "ASIO");
  const hasAsio4All = devices.some(
    (device) => device.backend === "ASIO" && /asio4all/i.test(device.name),
  );
  const showAsioSetup =
    form.values.backend === "ASIO" &&
    (asioUnavailable || !hasAsioDriver || hasAsio4All || asioReadyToRestart);

  return (
    <div className="settingsStack audioSettings">
      <Card
        border
        icon="wave"
        title={t("audioDevicesTitle")}
        description={t("audioDevicesHint")}
      >
        <div className="settingsStack">
          {!audioAvailable && (
            <MessageBar tone="error">{t("audioServiceUnavailable")}</MessageBar>
          )}
          <AudioFields
            form={form}
            onCommit={onAudioCommit}
            fields={audioRows(
              t,
              form.values,
              runtime,
              devices,
              audioAvailable,
              onPlayTestSound,
              configurationCapabilities,
              releaseAsioInBackground,
              onReleaseAsioInBackgroundChange,
            )}
          />
          {microphoneIssue && (
            <MessageBar
              tone="warning"
              action={
                privacyIssues.has(capabilities.microphone) && (
                  <Button
                    size="sm"
                    onClick={() => void desktopClient.openMicrophonePrivacy()}
                  >
                    {t("openMicrophonePrivacy")}
                  </Button>
                )
              }
            >
              {t(microphoneMessage[capabilities.microphone])}
            </MessageBar>
          )}
        </div>
      </Card>
      {showAsioSetup && (
        <AsioSetupCard
          hasAsio4All={hasAsio4All}
          readyToRestart={asioReadyToRestart}
          onAsioDriverDetected={onAsioDriverDetected}
          onOpenAsioControlPanel={onOpenAsioControlPanel}
        />
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
