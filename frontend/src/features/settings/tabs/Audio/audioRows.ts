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
  const periodFallback = values.backend === "WASAPI Shared" &&
    runtime.backend === "WASAPI Shared" && runtime.periodFrames > 0 &&
    (runtime.requestedPeriodFrames ?? 0) > 0 &&
    runtime.periodSelectionFallback === "UNSUPPORTED_BY_CAPABILITIES";
  const periodRate = runtime.sampleRate || configurationCapabilities.defaultSampleRate || values.sampleRate || 1;
  const describePeriod = (frames: number) =>
    `${t("framesValue", { value: frames })} / ${(frames * 1000 / periodRate).toFixed(2)} ms`;
  const periodMismatchReason = runtime.periodMismatchReason ??
    (periodFallback ? "UNSUPPORTED_PERIOD" : runtime.sharedPeriodFallback ??
      (runtime.sharedPeriodLocked ? "ENGINE_PERIODICITY_LOCKED" : "NONE"));
  const periodDetails: readonly [MessageKey, number][] = [
    ["audioPeriodSelected", runtime.selectedPeriodFrames || values.periodFrames],
    ["audioPeriodRequested", runtime.requestedPeriodFrames || values.periodFrames],
    ["audioPeriodActual", runtime.periodFrames],
  ];
  const periodActual = values.backend === "WASAPI Shared" && runtime.backend === "WASAPI Shared"
    ? `${periodDetails.filter(([, frames]) => frames > 0)
      .map(([label, frames]) => `${t(label)}: ${describePeriod(frames)}`).join(" · ")}` +
      ` · ${t("runtimeEndpointBuffer")}: ${t("framesValue", { value: runtime.endpointBufferFrames })}` +
      (periodMismatchReason !== "NONE" ? ` · ${t("audioPeriodReason")}: ${periodMismatchReason}` : "") +
      (periodFallback ? ` · ${t("runtimePeriodFallbackUnsupported", { value: runtime.requestedPeriodFrames ?? 0 })}` : "")
    : `${actual(t("framesValue", { value: runtime.periodFrames }))} · ${t("runtimeEndpointBuffer")}: ${t("framesValue", { value: runtime.endpointBufferFrames })}`;
  const supportedRates = [
    ...new Set([...configurationCapabilities.sampleRates, runtime.sampleRate]),
  ]
    .filter((value) => value > 0)
    .sort((left, right) => left - right);
  const supportedPeriods = [
    ...new Set(values.backend === "WASAPI Shared"
      ? configurationCapabilities.periodFrames
      : [...configurationCapabilities.periodFrames, runtime.periodFrames]),
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
  const periodReason = ({
    ONLY_ONE_PERIOD: t("audioPeriodOnlyOne"),
    IAUDIOCLIENT3_UNAVAILABLE: t("audioPeriodClient3Unavailable"),
    CAPABILITIES_QUERY_FAILED: t("audioPeriodQueryFailed"),
  } as Record<string, string>)[configurationCapabilities.periodSelectionReason ?? ""] ??
    (visiblePeriods.length === 1 ? t("audioPeriodOnlyOne") : "");
  const frameRow: SelectField =
    values.backend === "WASAPI Shared"
      ? {
          kind: "select",
          tag: "periodFrames",
          label: t("audioPeriod"),
          hint: `${periodActual}${periodReason ? ` · ${periodReason}` : ""}`,
          options: visiblePeriods.map((frames) => ({
            value: frames,
            label: `${t("framesValue", { value: frames })} — ${(frames * 1000 / (configurationCapabilities.defaultSampleRate || runtime.sampleRate || 1)).toFixed(2)} ms`,
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
    ...(values.backend === "WASAPI Shared" &&
      (configurationCapabilities.inputPeriodFrames?.length ?? 0) > 0
      ? [{
          kind: "select" as const,
          tag: "inputPeriodFrames" as const,
          label: t("audioInputPeriod"),
          hint: `${t("audioPeriodSelected")}: ${values.inputPeriodFrames
            ? `${t("framesValue", { value: values.inputPeriodFrames })} / ` +
              `${(values.inputPeriodFrames * 1000 / (configurationCapabilities.inputSampleRate || runtime.sampleRate || 1)).toFixed(2)} ms`
            : t("audioInputPeriodFollowOutput")} · ` +
            `${t("audioPeriodRequested")}: ${t("framesValue", { value: runtime.requestedInputPeriodFrames || runtime.requestedPeriodFrames || values.periodFrames })} / ` +
            `${((runtime.requestedInputPeriodFrames || runtime.requestedPeriodFrames || values.periodFrames) * 1000 / (configurationCapabilities.inputSampleRate || runtime.sampleRate || 1)).toFixed(2)} ms · ` +
            `${t("audioPeriodActual")}: ${t("framesValue", { value: runtime.inputPeriodFrames ?? 0 })} / ` +
            `${((runtime.inputPeriodFrames ?? 0) * 1000 / (configurationCapabilities.inputSampleRate || runtime.sampleRate || 1)).toFixed(2)} ms` +
            `${runtime.inputPeriodMismatchReason && runtime.inputPeriodMismatchReason !== "NONE"
              ? ` · ${t("audioPeriodReason")}: ${runtime.inputPeriodMismatchReason}` : ""}`,
          options: [
            { value: 0, label: t("audioInputPeriodFollowOutput") },
            ...(configurationCapabilities.inputPeriodFrames ?? []).map((frames) => ({
              value: frames,
              label: `${t("framesValue", { value: frames })} — ` +
                `${(frames * 1000 / (configurationCapabilities.inputSampleRate || runtime.sampleRate || 1)).toFixed(2)} ms`,
            })),
          ],
        } satisfies SelectField]
      : []),
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
