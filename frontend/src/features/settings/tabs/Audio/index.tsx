import {
  Button,
  Grid,
  IconButton,
  MessageBar,
  Select,
  Stack,
  Switch,
  Tooltip,
  Typography,
} from "@neo-ui-kit/react";
import type { ReactNode } from "react";
import type {
  AudioCapabilities,
  AudioConfigurationCapabilities,
  AudioBackendName,
  DeviceDto,
  RuntimeAudioConfiguration,
} from "../../../../contracts/models";
import type { MessageKey } from "../../../../i18n/messages";
import { useText } from "../../../../i18n/useText";
import { useSettingsDesktop } from "../../../../app/SettingsProvider";
import { AsioSetupCard } from "./ui/AsioSetupCard";
import { AudioMonitoring } from "./ui/AudioMonitoring";
import {
  audioOptions,
  backendLabel,
  deviceOptions,
} from "./model/audioOptions";
import type { AudioCommit, AudioValues } from "./model/audioConfiguration";
import "./ui/audio.css";

const microphoneMessage = {
  ready: "microphoneReady",
  "permission-denied": "microphonePermissionDenied",
  "privacy-disabled": "microphonePrivacyDisabled",
  missing: "microphoneMissing",
  busy: "microphoneBusy",
} as const satisfies Record<AudioCapabilities["microphone"], MessageKey>;

const deviceFields = [
  ["inputDeviceId", "audioInputDevice", "input"],
  ["outputDeviceId", "audioOutputDevice", "output"],
] as const;

export interface AudioSettingsProps {
  values: AudioValues;
  runtime: RuntimeAudioConfiguration;
  devices: readonly DeviceDto[];
  capabilities: AudioCapabilities;
  configurationCapabilities: AudioConfigurationCapabilities;
  configurationCapabilitiesBackend?: AudioBackendName;
  audioAvailable: boolean;
  onPlayTestSound(): void;
  asioUnavailable?: boolean;
  asioReadyToRestart?: boolean;
  onAsioDriverDetected(device: DeviceDto): void;
  onOpenAsioControlPanel(): void;
  releaseAsioInBackground: boolean;
  onReleaseAsioInBackgroundChange(value: boolean): void;
  onAudioCommit: AudioCommit;
}

const FieldRow = ({
  children,
  actions,
  columns,
  align = "start",
}: {
  children: ReactNode;
  actions?: ReactNode;
  columns: number;
  align?: "start" | "end";
}) => (
  <div
    className={`audioFieldsTopRow${actions ? " audioFieldsWithActions" : ""}`}
  >
    <Grid columns={columns} gap={4} align={align}>
      {children}
    </Grid>
    {actions}
  </div>
);

export const AudioSettings = (props: AudioSettingsProps) => {
  const { values, runtime, devices } = props;
  const t = useText();
  const desktop = useSettingsDesktop();
  const asio = values.backend === "ASIO";
  const shared = values.backend === "WASAPI Shared";
  const microphoneIssue = props.capabilities.microphone !== "ready";
  const privacyIssue =
    props.capabilities.microphone === "permission-denied" ||
    props.capabilities.microphone === "privacy-disabled";
  const asioDrivers = devices.filter((device) => device.backend === "ASIO");
  const selectedDriver =
    asioDrivers.find((device) => device.id === values.outputDeviceId) ??
    asioDrivers.find((device) => device.id === values.inputDeviceId) ??
    asioDrivers[0];
  const usesAsio4All = /asio4all/i.test(selectedDriver?.name ?? "");
  const options = audioOptions({
    t,
    values,
    runtime,
    configurationCapabilities: props.configurationCapabilities,
    capabilitiesBackend: props.configurationCapabilitiesBackend,
  });
  const availableDevices = devices.filter((device) =>
    asio ? device.backend === "ASIO" : device.backend !== "ASIO",
  );
  const playTest = (
    <Stack gap="0.25rem" align="center">
      <Tooltip content={t("playTestSound")}>
        <IconButton
          round
          size="lg"
          icon="play"
          label={t("playTestSound")}
          disabled={!props.audioAvailable}
          onClick={props.onPlayTestSound}
        />
      </Tooltip>
      <Typography variant="caption" tone="muted">
        {t("playTestSound")}
      </Typography>
    </Stack>
  );
  return (
    <div className="settingsStack audioSettings">
      <AudioMonitoring
        runtime={runtime}
        audioAvailable={props.audioAvailable}
        microphoneIssue={microphoneIssue}
        latencyControls={
          <Stack gap={3}>
            <FieldRow columns={2} align="end">
              <Select<AudioBackendName>
                label={t("audioBackend")}
                value={asio ? "ASIO" : "WASAPI Shared"}
                options={(["WASAPI Shared", "ASIO"] as const).map(
                  (backend) => ({
                    value: backend,
                    label: backendLabel(t, backend),
                  }),
                )}
                onValueChange={(value) => props.onAudioCommit("backend", value)}
              />
              <Select<number>
                label={t("sampleRate")}
                value={values.sampleRate}
                options={options.sampleRates}
                onValueChange={(value) =>
                  props.onAudioCommit("sampleRate", value)
                }
              />
              {!shared && (
                <Select<number>
                  label={t("audioBuffer")}
                  value={values.bufferFrames}
                  options={options.periods}
                  onValueChange={(value) =>
                    props.onAudioCommit("bufferFrames", value)
                  }
                />
              )}
            </FieldRow>
            {asio && asioDrivers.length > 0 && !usesAsio4All && (
              <Button
                className="audioDriverPanelAction"
                size="sm"
                icon="sliders"
                onClick={props.onOpenAsioControlPanel}
              >
                {t("asioSetupConfigure")}
              </Button>
            )}
          </Stack>
        }
        deviceControls={
          <div className="settingsStack">
            {!props.audioAvailable && (
              <MessageBar tone="error">
                {t("audioServiceUnavailable")}
              </MessageBar>
            )}
            {asio && props.asioUnavailable && asioDrivers.length > 0 && (
              <MessageBar tone="error">{t("asioDriverOpenFailed")}</MessageBar>
            )}
            <div className="settingsStack">
              <FieldRow columns={1} actions={playTest}>
                {deviceFields.map(([name, label, kind]) => (
                  <Select<string>
                    key={name}
                    label={t(label)}
                    value={values[name]}
                    {...deviceOptions(
                      t,
                      availableDevices.filter((device) => device.kind === kind),
                      values[name],
                    )}
                    onValueChange={(value) => props.onAudioCommit(name, value)}
                  />
                ))}
              </FieldRow>
              {(shared || asio) && (
                <Stack
                  direction="row"
                  gap="var(--ad-space-3) var(--ad-space-6)"
                  align="center"
                  wrap
                >
                  {shared ? (
                    <Stack gap="0.25rem">
                      <Stack direction="row" gap={2} align="center">
                        <Switch
                          label={t("lowLatencyMicrophone")}
                          checked={
                            props.audioAvailable &&
                            runtime.backend === "WASAPI Shared" &&
                            runtime.lowLatencyInputActive === true
                          }
                          onValueChange={(value) =>
                            props.onAudioCommit("lowLatencyInput", value)
                          }
                        />
                        <Tooltip content={t("lowLatencyMicrophoneHint")}>
                          <IconButton
                            size="sm"
                            variant="ghost"
                            icon="info"
                            label={t("lowLatencyMicrophoneHint")}
                          />
                        </Tooltip>
                      </Stack>
                      <Typography
                        className="audioFieldDescription"
                        variant="caption"
                        tone="muted"
                      >
                        {t("lowLatencyMicrophoneHint")}
                      </Typography>
                    </Stack>
                  ) : (
                    <Tooltip content={t("releaseAsioInBackgroundHint")}>
                      <Switch
                        label={t("releaseAsioInBackground")}
                        checked={props.releaseAsioInBackground}
                        onValueChange={props.onReleaseAsioInBackgroundChange}
                      />
                    </Tooltip>
                  )}
                </Stack>
              )}
            </div>
            {microphoneIssue && (
              <MessageBar
                tone="warning"
                action={
                  privacyIssue && (
                    <Button
                      size="sm"
                      onClick={() => void desktop.openMicrophonePrivacy()}
                    >
                      {t("openMicrophonePrivacy")}
                    </Button>
                  )
                }
              >
                {t(microphoneMessage[props.capabilities.microphone])}
              </MessageBar>
            )}
          </div>
        }
        technicalControls={
          shared ? (
            <FieldRow columns={2}>
              <Select<number>
                label={t("audioPeriod")}
                value={values.periodFrames}
                options={options.periods}
                onValueChange={(value) =>
                  props.onAudioCommit("periodFrames", value)
                }
              />
              {options.inputPeriods.length > 0 && (
                <Select<number>
                  label={t("audioInputPeriod")}
                  value={values.inputPeriodFrames ?? 0}
                  options={options.inputPeriods}
                  onValueChange={(value) =>
                    props.onAudioCommit("inputPeriodFrames", value)
                  }
                />
              )}
            </FieldRow>
          ) : undefined
        }
      />
      {asio &&
        (!asioDrivers.length || usesAsio4All || props.asioReadyToRestart) && (
          <AsioSetupCard
            hasAsio4All={asioDrivers.some((device) =>
              /asio4all/i.test(device.name),
            )}
            readyToRestart={props.asioReadyToRestart ?? false}
            onAsioDriverDetected={props.onAsioDriverDetected}
            onOpenAsioControlPanel={props.onOpenAsioControlPanel}
          />
        )}
    </div>
  );
};
