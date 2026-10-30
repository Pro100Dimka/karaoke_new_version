import { useFormContext, Header, Select, Stack, Typography, tr } from '@neo-ui-kit/react';
import { ru } from '../../../../../i18n/messages.ru';
import type { SettingsFormValues } from '../../../../../utils/contracts';
import { AcousticCalibration } from './AcousticCalibration';

export default function AudioDiagnostics() {
  const form = useFormContext<SettingsFormValues>();
  const { runtime, audioAvailable } = form.values.audioStatus;
  const usb = audioAvailable ? runtime.usbLatency : undefined;
  const parts = audioAvailable ? runtime.latencyParts : undefined;
  const timing = audioAvailable ? runtime.latencyTiming : undefined;
  const notes = [
    "latencyNoCalibrationRequired",
    "latencyBoundaryHint",
    ...(runtime.captureTimestampAdjusted
      ? (["latencyTimestampAdjusted"] as const)
      : []),
    "latencyModelNotAdditive",
  ] as const;
  const partRows = parts
    ? ([
        [
          parts.inputReportedMs
            ? "latencyPartInput"
            : "latencyPartInputAssumed",
          parts.inputMs === null ? null : Math.round(parts.inputMs),
        ],
        [
          "latencyPartOutput",
          parts.outputMs === null ? null : Math.round(parts.outputMs),
        ],
        ["latencyPartBridge", parts.bridgeMs?.toFixed(2) ?? null],
        ["latencyPartDsp", parts.dspMs?.toFixed(2) ?? null],
      ] as const)
    : [];
  return (
            <Stack style={{ maxHeight: "70vh", overflow: "auto" }} gap={3}>
              <Header
                compact
                icon="info"
                level={4}
                title={tr(ru.latencyTechnicalDetails)}
              />
              {notes.map((note) => (
                <Typography key={note} variant="caption" tone="muted">
                  {tr(ru[note])}
                </Typography>
              ))}
              {audioAvailable && runtime.backend !== "ASIO" && (
                <Stack gap="0.15rem">
                  {([
                    ["latencyUsbInput", usb?.inputMs],
                    ["latencyUsbOutput", usb?.outputMs],
                  ] as const).map(([label, milliseconds]) => (
                    <Typography key={label} variant="caption" tone="muted">
                      {tr(ru[label], {
                        value: milliseconds == null
                          ? tr(ru.latencyUsbUnknown) : milliseconds.toFixed(2),
                      })}
                    </Typography>
                  ))}
                  <Typography variant="caption" tone="muted">
                    {tr(ru.latencyUsbHint)}
                  </Typography>
                </Stack>
              )}
              {parts && (
                <Stack as="ul" gap="0.15rem" style={{ margin: 0, padding: 0, listStyle: "none" }}>
                  {partRows.map(([label, value]) =>
                    value === null ? null : (
                      <Typography
                        key={label}
                        as="li"
                        variant="caption"
                        tone="muted"
                      >
                        {tr(ru[label], { value })}
                      </Typography>
                    ),
                  )}
                </Stack>
              )}
              {timing && (
                <Stack gap="0.15rem">
                  {(
                    [
                      ["latencyRenderCallback", timing.renderCallbackP95Ms],
                      ["latencyCaptureCallback", timing.captureCallbackP95Ms],
                      ["latencyJitWait", timing.jitWaitP95Ms],
                      [
                        "latencyDeadlineOvershoot",
                        timing.deadlineOvershootP95Ms,
                      ],
                    ] as const
                  ).map(([label, value]) =>
                    value === null ? null : (
                      <Typography key={label} variant="caption" tone="muted">
                        {tr(ru[label], { value: value.toFixed(3) })}
                      </Typography>
                    ),
                  )}
                  <Typography variant="caption" tone="muted">
                    {tr(ru.latencyTimingNotCpu)}
                  </Typography>
                </Stack>
              )}
              {audioAvailable && runtime.calibratedLatencyMs != null && (
                <Typography variant="caption" tone="muted">
                  {tr(ru.latencyActiveCorrection, {
                    value: runtime.calibratedLatencyMs.toFixed(2),
                  })}
                </Typography>
              )}
              {runtime.backend === "WASAPI Shared" && form.values.audioStatus.options.inputPeriods.length > 0 && (
                <Select label={tr(ru.audioInputPeriod)} value={form.values.audio.configuration.inputPeriodFrames ?? 0}
                  options={form.values.audioStatus.options.inputPeriods}
                  onValueChange={(value) => form.setValue("audio.configuration.inputPeriodFrames", value)} />
              )}
              <Header
                compact
                icon="wave"
                level={4}
                title={tr(ru.latencyOptionalAcoustic)}
              />
              <AcousticCalibration
                audioAvailable={audioAvailable}
                runtime={runtime}
              />
            </Stack>
  );
}
