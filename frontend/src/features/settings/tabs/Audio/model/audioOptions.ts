import type {
  AudioBackendName,
  AudioConfigurationCapabilities,
  DeviceDto,
  RuntimeAudioConfiguration,
} from "../../../../../contracts/models";
import type { ITranslate } from "../../../../../i18n/useText";
import type { AudioValues } from "./audioConfiguration";

export const backendLabel = (t: ITranslate, backend: AudioBackendName) =>
  backend === "ASIO" ? "ASIO" : t("audioBackendWindows");
export const deviceOptions = (
  t: ITranslate,
  devices: readonly DeviceDto[],
  current: string,
) => {
  const missing =
    current !== "" && !devices.some((device) => device.id === current);
  return {
    error: missing ? t("deviceUnavailable") : undefined,
    options: [
      ...(missing ? [{ value: current, label: t("deviceUnavailable") }] : []),
      { value: "", label: t("systemDefault") },
      ...devices.map((device) => ({ value: device.id, label: device.name })),
    ],
  };
};

/** Device-supported choices; no UI state or event dispatch. */
export const audioOptions = ({
  t,
  values,
  runtime,
  configurationCapabilities,
  capabilitiesBackend = runtime.backend,
}: {
  t: ITranslate;
  values: AudioValues;
  runtime: RuntimeAudioConfiguration;
  configurationCapabilities: AudioConfigurationCapabilities;
  capabilitiesBackend?: AudioBackendName;
}) => {
  const supportedRates = [
    ...new Set([
      ...(values.backend === capabilitiesBackend
        ? configurationCapabilities.sampleRates
        : []),
      ...(values.backend === runtime.backend ? [runtime.sampleRate] : []),
      values.sampleRate,
    ]),
  ]
    .filter((value) => value > 0)
    .sort((left, right) => left - right);
  const supportedPeriods = [
    ...new Set([
      ...(values.backend === capabilitiesBackend
        ? configurationCapabilities.periodFrames
        : []),
      ...(values.backend === runtime.backend &&
      values.backend !== "WASAPI Shared"
        ? [runtime.periodFrames]
        : []),
      ...(values.backend === "WASAPI Shared" &&
      values.backend === capabilitiesBackend
        ? []
        : [
            values.backend === "WASAPI Shared"
              ? values.periodFrames
              : values.bufferFrames,
          ]),
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
            (values.backend === runtime.backend &&
              value === runtime.periodFrames)
          );
        });
  const inputPeriods = configurationCapabilities.inputPeriodFrames ?? [];
  return {
    sampleRates: supportedRates.map((rate) => ({
      value: rate,
      label: t("kilohertzValue", { value: rate / 1000 }),
    })),
    periods: visiblePeriods.map((frames) => ({
      value: frames,
      label:
        values.backend === "WASAPI Shared"
          ? `${t("framesValue", { value: frames })} — ${((frames * 1000) / (configurationCapabilities.defaultSampleRate || runtime.sampleRate || 1)).toFixed(2)} ms`
          : t("framesValue", { value: frames }),
    })),
    inputPeriods: inputPeriods.length
      ? [
          { value: 0, label: t("audioInputPeriodFollowOutput") },
          ...inputPeriods.map((frames) => ({
            value: frames,
            label: `${t("framesValue", { value: frames })} — ${((frames * 1000) / (configurationCapabilities.inputSampleRate || runtime.sampleRate || 1)).toFixed(2)} ms`,
          })),
        ]
      : [],
  };
};
