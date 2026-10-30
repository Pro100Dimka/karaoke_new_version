import {
  Button,
  IconButton,
  LevelMeter,
  Stack,
  StatusIndicator,
  Tooltip,
  tr,
  Typography,
} from "@neo-ui-kit/react";
import { ru } from "../../../../../i18n/messages.ru";
import type {
  FormBlock,
  SettingsFormValues,
} from "../../../../../utils/contracts";
import FormButton from "../form-button";

const rotaryProps = {
  size: "sm",
  showLabel: true,
  min: 0,
  step: 0.01,
  displayScale: 100,
} as const;

export const blocks = (values: Pick<SettingsFormValues, "audio" | "audioStatus">, showDiagnostics: () => void) => {
  const status = values.audioStatus;
  const runtime = status.runtime;
  const usb =
    runtime.latencyEstimateSource === "device-timeline"
      ? (runtime.usbLatency?.inputMs ?? 0) + (runtime.usbLatency?.outputMs ?? 0)
      : 0;
  const latency =
    status.audioAvailable && runtime.estimatedLatencyMs !== null
      ? runtime.estimatedLatencyMs + usb
      : null;
  return {
    estimatedLatencyTitle: {
      span: { base: "full", md: 6, lg: 5 },
      icon: "timer",
      actions: (
        <Tooltip content={tr("audioLatencyHint")}>
          <IconButton
            icon="info"
            size="sm"
            variant="ghost"
            label={tr("audioLatencyHint")}
            onClick={showDiagnostics}
          />
        </Tooltip>
      ),
      fields: [
        {
          name: "audio.latency",
          kind: "custom",
          render: () => (
            <Stack gap={3}>
              <LevelMeter
                value={Math.min(1, status.inputLevel * 4) * 100}
                active={values.audio.voice.monitoring}
                label={tr("liveInputLevel")}
              />
              <Stack direction="row" gap={3} align="center" wrap>
                <Typography
                  variant="h3"
                  as="strong"
                  text={
                    latency === null
                      ? "—"
                      : tr(ru.approximateMillisecondsValue, {
                          value: Math.round(latency),
                        })
                  }
                />
                <StatusIndicator
                  status={status.audioAvailable ? "warning" : "offline"}
                  label={
                    status.audioAvailable
                      ? tr(ru.latencyIncomplete)
                      : tr("audioNoData")
                  }
                />
              </Stack>
            </Stack>
          ),
        },
        {
          name: "audio.configuration.backend",
          kind: "select",
          label: tr("audioBackend"),
          span: { base: "full", sm: 4 },
          props: {
            options: ["ASIO", "WASAPI Shared", "WASAPI Exclusive"],
            disabled: !status.ready,
          },
        },
        ...Object.entries({
          sampleRate: {
            label: "sampleRate",
            values: [0, 44100, 48000, 96000, 192000],
            unit: "kilohertzValue",
            scale: 1000,
          },
          bufferFrames: {
            label: "audioBuffer",
            values: [0, 32, 64, 128, 256, 512, 1024],
            unit: "framesValue",
            scale: 1,
          },
        }).map(([name, { label }]) => ({
          name: `audio.configuration.${name}`,
          kind: "select" as const,
          label: tr(label),
          span: { base: "full", sm: 4 } as const,
          props: {
            options:
              name === "sampleRate"
                ? status.options.sampleRates
                : status.options.periods,
          },
        })),
        {
          name: "audio.configureDevices",
          kind: "custom",
          render: () => (
            <Button
              size="sm"
              icon="sliders"
              disabled={
                !status.audioAvailable ||
                values.audio.configuration.backend !== "ASIO"
              }
              label={tr("audioConfigureDevices")}
              onClick={status.onOpenAsioControlPanel}
            />
          ),
        },
      ],
    },
    audioLevels: {
      span: { base: "full", md: 6, lg: 4 },
      icon: "levels",
      fields: [
        {
          name: "audio.voice.gain",
          kind: "rotary",
          label: tr("microphoneKnob"),
          span: 5,
          props: { ...rotaryProps, max: 4, resetValue: 1 },
        },
        {
          name: "audio.voice.monitoring",
          kind: "custom",
          span: 2,
          render: (field) => (
            <FormButton
              icon="mic"
              label={tr("inputMonitoring")}
              caption={tr("monitoring")}
              disabled={!status.canToggle}
              aria-pressed={Boolean(field.value)}
              variant={field.value ? "primary" : "secondary"}
              onClick={() => field.onValueChange(!field.value)}
            />
          ),
        },
        {
          name: "audio.voice.effects.noiseSuppression",
          kind: "rotary",
          label: tr("noiseKnob"),
          span: 5,
          props: { ...rotaryProps, max: 1, resetValue: 0 },
        },
      ],
    },
    audioDevicesAndMonitoring: {
      span: { base: "full", lg: 3 },
      icon: "headphones",
      fields: [
        ...Object.entries({
          inputDeviceId: { label: "audioInputDevice", span: "full" },
          outputDeviceId: {
            label: "audioOutputDevice",
            span: { base: "full", sm: 10 },
          },
        } as const).map(([name, { label, span }]) => ({
          name: `audio.configuration.${name}`,
          kind: "select" as const,
          label: tr(label),
          span,
          props: status.deviceOptions(
            name === "inputDeviceId" ? "input" : "output",
            values.audio.configuration[
              name as "inputDeviceId" | "outputDeviceId"
            ] ?? "",
          ),
        })),
        {
          name: "audio.playTestSound",
          kind: "custom",
          span: { base: "full", sm: 2 },
          render: () => (
            <Stack justify="center">
              <FormButton
                size="md"
                icon="play"
                label={tr(ru.playTestSound)}
                onClick={() => void status.onPlayTestSound()}
                disabled={!status.audioAvailable}
              />
            </Stack>
          ),
        },
        ...Object.entries({
          "audio.releaseAsioInBackground": {
            label: "releaseAsioInBackground",
            backend: "ASIO",
          },
          "audio.configuration.lowLatencyInput": {
            label: "lowLatencyMicrophone",
            backend: "WASAPI Shared",
          },
        }).map(([name, { label, backend }]) => ({
          name,
          kind: "switch" as const,
          label: tr(label),
          showWhen: (values: SettingsFormValues) =>
            values.audio.configuration.backend === backend,
        })),
      ],
    },
  } satisfies Record<string, FormBlock>;
};
