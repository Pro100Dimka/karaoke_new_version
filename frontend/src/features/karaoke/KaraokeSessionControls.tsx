import { BarChart3, Gauge, Headphones, Repeat2, RefreshCw } from "lucide-react";
import { useText } from "../../i18n/useText";
import { Button } from "../../theme/ui";

export const FinishedBar = ({
  hasRecording,
  hasAnalysis,
  onRepeat,
  onLibrary,
  onOpenRecording,
  onOpenAnalysis
}: {
  hasRecording: boolean;
  hasAnalysis: boolean;
  onRepeat(): void;
  onLibrary(): void;
  onOpenRecording(): void;
  onOpenAnalysis(): void;
}) => {
  const t = useText();

  return (
    <div className="finishedBar">
      <div className="finishedSummary">
        <Gauge aria-hidden size={20} />
        <div className="finishedCopy">
          <strong>{t("performanceFinished")}</strong>
          <span>{t("performanceReady")}</span>
        </div>
      </div>
      <div className="finishedActions">
        <Button variant="outlined" tone="neutral" startIcon={<Repeat2 size={16} />} onClick={onRepeat}>
          {t("repeat")}
        </Button>
        {hasRecording && (
          <Button variant="outlined" tone="neutral" startIcon={<Headphones size={16} />} onClick={onOpenRecording}>
            {t("openRecording")}
          </Button>
        )}
        {hasRecording && hasAnalysis && (
          <Button variant="outlined" tone="neutral" startIcon={<BarChart3 size={16} />} onClick={onOpenAnalysis}>
            {t("openAnalysis")}
          </Button>
        )}
        <Button onClick={onLibrary}>
          {t("library")}
        </Button>
      </div>
    </div>
  );
};

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
