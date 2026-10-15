import type { FormApi } from "@neo-ui-kit/react";
import { Button, MessageBar, Stack } from "@neo-ui-kit/react";
import { useSettingsDesktop } from "../../../../app/SettingsProvider";
import type {
  AudioCapabilities,
  AudioConfigurationCapabilities,
  DeviceDto,
  RuntimeAudioConfiguration,
} from "../../../../contracts/models";
import type { MessageKey } from "../../../../i18n/messages";
import { useText } from "../../../../i18n/useText";
import { AsioSetupCard } from "./AsioSetupCard";
import "./audio.css";
import { AudioFields } from "./AudioFields";
import { audioRows, type AudioField } from "./audioRows";
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

export interface AudioSettingsProps<T extends AudioValues = AudioValues> {
  form: FormApi<T>;
  runtime: RuntimeAudioConfiguration;
  devices: readonly DeviceDto[];
  capabilities: AudioCapabilities;
  configurationCapabilities: AudioConfigurationCapabilities;
  configurationCapabilitiesBackend?: AudioValues["backend"];
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

export const AudioSettings = <T extends AudioValues>({
  form,
  runtime,
  devices,
  capabilities,
  configurationCapabilities,
  configurationCapabilitiesBackend,
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
}: AudioSettingsProps<T>) => {
  const t = useText();
  const desktop = useSettingsDesktop();
  const microphoneIssue = capabilities.microphone !== "ready";
  const asioDrivers = devices.filter((device) => device.backend === "ASIO");
  const hasAsioDriver = asioDrivers.length > 0;
  const hasAsio4All = asioDrivers.some((device) => /asio4all/i.test(device.name));
  const selectedDriver = [form.values.outputDeviceId, form.values.inputDeviceId]
    .map((id) => asioDrivers.find((device) => device.id === id))
    .find((device) => device !== undefined) ?? asioDrivers[0];
  const usesAsio4All = /asio4all/i.test(selectedDriver?.name ?? "");
  const showAsioSetup =
    form.values.backend === "ASIO" &&
    (!hasAsioDriver || usesAsio4All || asioReadyToRestart);
  const fields = audioRows(
    t,
    form.values,
    runtime,
    devices,
    audioAvailable,
    onPlayTestSound,
    configurationCapabilities,
    releaseAsioInBackground,
    onReleaseAsioInBackgroundChange,
    configurationCapabilitiesBackend,
    (value) => onAudioCommit("lowLatencyInput", value),
  );
  const fieldKey = (field: AudioField) =>
    field.kind === "select" ? field.tag : field.key;
  const groups = {
    latency: fields.filter((field) =>
      ["backend", "sampleRate", "bufferFrames"].includes(fieldKey(field)),
    ),
    devices: fields.filter((field) =>
      [
        "inputDeviceId",
        "outputDeviceId",
        "lowLatencyInput",
        "playTestSound",
        "releaseAsioInBackground",
      ].includes(fieldKey(field)),
    ),
  };
  const technical = fields.filter(
    (field) => !groups.latency.includes(field) && !groups.devices.includes(field),
  );

  return (
    <div className="settingsStack audioSettings">
      <AudioTests
        runtime={runtime}
        audioAvailable={audioAvailable}
        microphoneIssue={microphoneIssue}
        inputLevel={inputLevel}
        testingInput={testingInput}
        onToggleInputTest={onToggleInputTest}
        onPlayTestSound={onPlayTestSound}
        latencyControls={
          <Stack gap={3}>
            <AudioFields
              form={form}
              onCommit={onAudioCommit}
              fields={groups.latency}
              columns={2}
              showDescriptions={false}
            />
            {form.values.backend === "ASIO" && hasAsioDriver && !usesAsio4All && (
              <Button
                className="audioDriverPanelAction"
                size="sm"
                icon="sliders"
                onClick={onOpenAsioControlPanel}
              >
                {t("asioSetupConfigure")}
              </Button>
            )}
          </Stack>
        }
        deviceControls={
          <div className="settingsStack">
            {!audioAvailable && (
              <MessageBar tone="error">
                {t("audioServiceUnavailable")}
              </MessageBar>
            )}
            {form.values.backend === "ASIO" &&
              asioUnavailable &&
              hasAsioDriver && (
                <MessageBar tone="error">
                  {t("asioDriverOpenFailed")}
                </MessageBar>
              )}
            <AudioFields
              form={form}
              onCommit={onAudioCommit}
              fields={groups.devices}
              columns={1}
            />
            {microphoneIssue && (
              <MessageBar
                tone="warning"
                action={
                  privacyIssues.has(capabilities.microphone) && (
                    <Button
                      size="sm"
                      onClick={() => void desktop.openMicrophonePrivacy()}
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
        }
        technicalControls={
          technical.length > 0 ? (
            <AudioFields
              form={form}
              onCommit={onAudioCommit}
              fields={technical}
              columns={2}
            />
          ) : undefined
        }
      />
      {showAsioSetup && (
        <AsioSetupCard
          hasAsio4All={hasAsio4All}
          readyToRestart={asioReadyToRestart}
          onAsioDriverDetected={onAsioDriverDetected}
          onOpenAsioControlPanel={onOpenAsioControlPanel}
        />
      )}
    </div>
  );
};
