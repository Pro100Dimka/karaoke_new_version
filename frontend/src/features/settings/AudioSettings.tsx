import type { FormikProps } from "formik";
import { useId } from "react";
import type { AudioCapabilities, DeviceDto, RuntimeAudioConfiguration } from "../../contracts/models";
import type { MessageKey } from "../../i18n/messages";
import { useText } from "../../i18n/useText";
import { desktopClient } from "../../services/desktopClient";
import { Alert } from "../../shared/ui/Alert";
import { Button, RenderFormikFields } from "../../theme/ui";
import { audioRows } from "./audioRows";
import { AudioTests } from "./AudioTests";
import type { AudioValues } from "./settingsModel";

const microphoneMessage = {
  ready: "microphoneReady",
  "permission-denied": "microphonePermissionDenied",
  "privacy-disabled": "microphonePrivacyDisabled",
  missing: "microphoneMissing",
  busy: "microphoneBusy"
} as const satisfies Record<AudioCapabilities["microphone"], MessageKey>;

export const AudioSettings = ({
  formik,
  runtime,
  devices,
  capabilities,
  audioAvailable,
  inputLevel,
  testingInput,
  onToggleInputTest,
  onPlayTestSound,
  onAudioCommit
}: {
  formik: FormikProps<AudioValues>;
  runtime: RuntimeAudioConfiguration;
  devices: readonly DeviceDto[];
  capabilities: AudioCapabilities;
  audioAvailable: boolean;
  inputLevel: number;
  testingInput: boolean;
  onToggleInputTest(enabled: boolean): void;
  onPlayTestSound(): void;
  /** Called with every committed field so the new configuration is applied at once. */
  onAudioCommit(name: string, value: unknown): void;
}) => {
  const t = useText();
  const titleId = useId();
  const microphoneIssue = capabilities.microphone !== "ready";
  const privacyIssue = capabilities.microphone === "permission-denied" || capabilities.microphone === "privacy-disabled";

  return (
    <section aria-labelledby={titleId}>
      <h2 id={titleId}>{t("audio")}</h2>
      {!audioAvailable && <Alert intent="error">{t("audioServiceUnavailable")}</Alert>}
      <RenderFormikFields formik={formik} items={audioRows(t, formik.values, runtime, devices)} onFieldCommit={onAudioCommit} />
      {microphoneIssue && (
        <Alert
          intent="warning"
          actions={
            privacyIssue ? (
              <Button size="sm" onClick={() => void desktopClient.openMicrophonePrivacy()}>
                {t("openMicrophonePrivacy")}
              </Button>
            ) : undefined
          }
        >
          {t(microphoneMessage[capabilities.microphone])}
        </Alert>
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
      <p className="muted">{t("audioRuntimeHint")}</p>
    </section>
  );
};
