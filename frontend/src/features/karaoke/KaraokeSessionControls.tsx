import { RefreshCw } from "lucide-react";
import { useText } from "../../i18n/useText";
import { Button } from "../../theme/ui";

export const RecoveryBar = ({
  recovering,
  onResume,
  onStop,
  onAudioSettings
}: {
  recovering: boolean;
  onResume(): void;
  onStop(): void;
  onAudioSettings(): void;
}) => {
  const t = useText();

  return (
    <div className="finishedBar" role="status">
      <div className="finishedSummary">
        <RefreshCw aria-hidden size={20} />
        <div className="finishedCopy">
          <strong>{t(recovering ? "recoveringAudio" : "audioRecovered")}</strong>
          <span>{t(recovering ? "recoveringAudioHint" : "audioRecoveredHint")}</span>
        </div>
      </div>
      <div className="finishedActions">
        <Button disabled={recovering} onClick={onResume}>
          {t("resume")}
        </Button>
        <Button variant="outlined" tone="neutral" onClick={onStop}>{t("stop")}</Button>
        <Button variant="outlined" tone="neutral" onClick={onAudioSettings}>{t("openAudioSettings")}</Button>
      </div>
    </div>
  );
};
