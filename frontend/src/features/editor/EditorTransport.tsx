import { MoveHorizontal, MoveVertical, Pause, Play, ZoomIn, ZoomOut } from "lucide-react";
import { useText } from "../../i18n/useText";
import { formatPreciseTime } from "../../shared/utils/format";
import { IconButton, Slider, Switch } from "../../theme/ui";

export const EditorTransport = ({
  playing,
  position,
  duration,
  zoom,
  follow,
  snap,
  audioReady,
  onTogglePlay,
  onPositionChange,
  onZoomChange,
  onFollowChange,
  onSnapChange
}: {
  playing: boolean;
  position: number;
  duration: number;
  zoom: number;
  follow: boolean;
  snap: boolean;
  audioReady: boolean;
  onTogglePlay(): void;
  onPositionChange(value: number): void;
  onZoomChange(value: number): void;
  onFollowChange(value: boolean): void;
  onSnapChange(value: boolean): void;
}) => {
  const t = useText();
  const max = Math.max(duration, 1);

  return (
    <div className="editorTransport" role="toolbar" aria-label={t("editorTransport")}>
      <IconButton variant="contained" size="lg" icon={playing ? Pause : Play} label={t(playing ? "pause" : "play")} disabled={!audioReady} onClick={onTogglePlay} />
      <span>{formatPreciseTime(position)}</span>
      <Slider aria-label={t("songPosition")} min={0} max={max} step={0.01} value={Math.min(position, max)} showValue={false} onChange={onPositionChange} />
      <Switch variant="plain" checked={follow} label={<MoveHorizontal size={15} aria-label={t("followPlayhead")} />} aria-label={t("followPlayhead")} onChange={onFollowChange} />
      <Switch variant="plain" checked={snap} label={<MoveVertical size={15} aria-label={t("snapToGrid")} />} aria-label={t("snapToGrid")} onChange={onSnapChange} />
      <div className="zoomControls" role="group" aria-label={t("zoom")}>
        <IconButton variant="ghost" icon={ZoomOut} label={t("zoomOut")} onClick={() => onZoomChange(Math.max(0.25, zoom / 1.25))} />
        <strong>{Math.round(zoom * 100)}%</strong>
        <IconButton variant="ghost" icon={ZoomIn} label={t("zoomIn")} onClick={() => onZoomChange(Math.min(6, zoom * 1.25))} />
      </div>
    </div>
  );
};
