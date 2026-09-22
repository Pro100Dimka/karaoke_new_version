import type {
  AudioBackendName,
  DeviceDto,
  RuntimeAudioConfiguration,
} from "../../contracts/models";
import type { MessageKey } from "../../i18n/messages";
import { Button, type FormRow } from "../../theme/ui";
import type { AudioValues } from "./settingsModel";

const backendOptions = [
  "WASAPI Shared",
  "WASAPI Exclusive",
  "ASIO",
] as const satisfies readonly AudioBackendName[];
const sampleRateOptions = [44100, 48000, 96000] as const;
const periodOptions = [64, 128, 256, 512, 1024] as const;

type Translate = (
  key: MessageKey,
  params?: Record<string, string | number>,
) => string;

const deviceRow = (
  t: Translate,
  tag: "inputDeviceId" | "outputDeviceId",
  label: MessageKey,
  devices: readonly DeviceDto[],
  current: string,
): FormRow => {
  // A stored device that disappeared stays selected and is flagged, never silently swapped for another one.
  const missing =
    current !== "" && !devices.some((device) => device.id === current);
  return {
    type: "SelectField",
    md: 4,
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
  t: Translate,
  values: AudioValues,
  runtime: RuntimeAudioConfiguration,
  devices: readonly DeviceDto[],
  audioAvailable: boolean,
  onPlayTestSound: () => void,
): FormRow[] => {
  const actual = (value: string) => t("runtimeActual", { value });
  const periodActual = `${actual(t("framesValue", { value: runtime.periodFrames }))} · ${t("runtimeEndpointBuffer")}: ${t("framesValue", { value: runtime.endpointBufferFrames })}`;
  const rows: FormRow[] = [
    {
      md: 4,
      type: "SelectField",
      tag: "backend",
      label: t("audioBackend"),
      tooltip: actual(runtime.backend),
      options: backendOptions.map((value) => ({ value, label: value })),
    },
    {
      md: 4,
      type: "SelectField",
      tag: "sampleRate",
      label: t("sampleRate"),
      tooltip: actual(
        t("kilohertzValue", { value: runtime.sampleRate / 1000 }),
      ),
      options: sampleRateOptions.map((rate) => ({
        value: rate,
        label: t("kilohertzValue", { value: rate / 1000 }),
      })),
    },
    {
      md: 4,
      type: "SelectField",
      tag: "periodFrames",
      label: t("audioPeriod"),
      tooltip: periodActual,
      options: periodOptions.map((frames) => ({
        value: frames,
        label: t("framesValue", { value: frames }),
      })),
    },
    deviceRow(
      t,
      "inputDeviceId",
      "audioInputDevice",
      devices.filter((device) => device.kind === "input"),
      values.inputDeviceId,
    ),
    deviceRow(
      t,
      "outputDeviceId",
      "audioOutputDevice",
      devices.filter((device) => device.kind === "output"),
      values.outputDeviceId,
    ),
    {
      md: 4,
      type: "Custom",
      render: () => (
        <Button
          type="button"
          size="sm"
          variant="outlined"
          tone="neutral"
          disabled={!audioAvailable}
          onClick={onPlayTestSound}
        >
          {t("playTestSound")}
        </Button>
      ),
    },
  ];
  return rows.map((row) => ({ md: 6, ...row }));
};
