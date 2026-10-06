import type {
  AudioBackendName,
  AudioConfigurationCapabilities,
  DeviceDto,
  RuntimeAudioConfiguration,
} from "../../../../contracts/models";
import type { MessageKey } from "../../../../i18n/messages";
import { ITranslate } from "../../../../i18n/useText";
import type { AudioValues } from "./settingsModel";

export interface AudioOption {
  value: string | number;
  label: string;
}
/** One control of the device form: a select bound to a form value, the ASIO release switch or the test-sound action. */
export type AudioField =
  | {
      kind: "select";
      tag: keyof AudioValues;
      label: string;
      hint?: string;
      error?: string;
      options: readonly AudioOption[];
    }
  | {
      kind: "switch";
      key: string;
      label: string;
      hint: string;
      checked: boolean;
      onChange(value: boolean): void;
    }
  | {
      kind: "action";
      key: string;
      label: string;
      disabled: boolean;
      onClick(): void;
    };
type SelectField = Extract<AudioField, { kind: "select" }>;

const backendOptions = [
  "WASAPI Shared",
  "WASAPI Exclusive",
  "ASIO",
] as const satisfies readonly AudioBackendName[];

const deviceRow = (
  t: ITranslate,
  tag: "inputDeviceId" | "outputDeviceId",
  label: MessageKey,
  devices: readonly DeviceDto[],
  current: string,
): SelectField => {
  // A stored device that disappeared stays selected and is flagged, never silently swapped for another one.
  const missing =
    current !== "" && !devices.some((device) => device.id === current);
  return {
    kind: "select",
    tag,
    label: t(label),
    error: missing ? t("deviceUnavailable") : undefined,
    options: [
      ...(missing ? [{ value: current, label: t("deviceUnavailable") }] : []),
      { value: "", label: t("systemDefault") },
      ...devices.map((device) => ({ value: device.id, label: device.name })),
    ],
  };
};

/** Rows of the "requested configuration" form; the value AudioService really runs with sits behind each info icon. */
export const audioRows = (
  t: ITranslate,
  values: AudioValues,
  runtime: RuntimeAudioConfiguration,
  devices: readonly DeviceDto[],
  audioAvailable: boolean,
  onPlayTestSound: () => void,
  configurationCapabilities: AudioConfigurationCapabilities,
  releaseAsioInBackground = false,
  onReleaseAsioInBackgroundChange: (value: boolean) => void = () => undefined,
): AudioField[] => {
  const backendDevices = devices.filter((device) =>
    values.backend === "ASIO"
      ? device.backend === "ASIO"
      : device.backend !== "ASIO",
  );
  const actual = (value: string) => t("runtimeActual", { value });
  const periodActual = `${actual(t("framesValue", { value: runtime.periodFrames }))} · ${t("runtimeEndpointBuffer")}: ${t("framesValue", { value: runtime.endpointBufferFrames })}`;
  const supportedRates = [
    ...new Set([...configurationCapabilities.sampleRates, runtime.sampleRate]),
  ]
    .filter((value) => value > 0)
    .sort((left, right) => left - right);
  const supportedPeriods = [
    ...new Set([
      ...configurationCapabilities.periodFrames,
      runtime.periodFrames,
    ]),
  ]
    .filter((value) => value > 0)
    .sort((left, right) => left - right);
  const visiblePeriods =
    values.backend !== "ASIO"
      ? supportedPeriods
      : supportedPeriods.filter((value) => {
          const standardAsioBuffer = value >= 32 && (value & (value - 1)) === 0;
          return (
            standardAsioBuffer ||
            value === values.bufferFrames ||
            value === runtime.periodFrames
          );
        });
  const frameRow: SelectField =
    values.backend === "WASAPI Shared"
      ? {
          kind: "select",
          tag: "periodFrames",
          label: t("audioPeriod"),
          hint: periodActual,
          options: visiblePeriods.map((frames) => ({
            value: frames,
            label: t("framesValue", { value: frames }),
          })),
        }
      : {
          kind: "select",
          tag: "bufferFrames",
          label: t("audioBuffer"),
          hint: periodActual,
          options: visiblePeriods.map((frames) => ({
            value: frames,
            label: t("framesValue", { value: frames }),
          })),
        };
  return [
    {
      kind: "select",
      tag: "backend",
      label: t("audioBackend"),
      hint: actual(runtime.backend),
      options: backendOptions.map((value) => ({ value, label: value })),
    },
    {
      kind: "select",
      tag: "sampleRate",
      label: t("sampleRate"),
      hint: actual(t("kilohertzValue", { value: runtime.sampleRate / 1000 })),
      options: supportedRates.map((rate) => ({
        value: rate,
        label: t("kilohertzValue", { value: rate / 1000 }),
      })),
    },
    frameRow,
    ...(values.backend === "ASIO"
      ? [
          {
            kind: "switch",
            key: "releaseAsioInBackground",
            label: t("releaseAsioInBackground"),
            hint: t("releaseAsioInBackgroundHint"),
            checked: releaseAsioInBackground,
            onChange: onReleaseAsioInBackgroundChange,
          } satisfies AudioField,
        ]
      : []),
    deviceRow(
      t,
      "inputDeviceId",
      "audioInputDevice",
      backendDevices.filter((device) => device.kind === "input"),
      values.inputDeviceId,
    ),
    deviceRow(
      t,
      "outputDeviceId",
      "audioOutputDevice",
      backendDevices.filter((device) => device.kind === "output"),
      values.outputDeviceId,
    ),
    {
      kind: "action",
      key: "playTestSound",
      label: t("playTestSound"),
      disabled: !audioAvailable,
      onClick: onPlayTestSound,
    },
  ];
};
