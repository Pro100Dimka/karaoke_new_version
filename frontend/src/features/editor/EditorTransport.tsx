import { useState, type CSSProperties } from "react";
import { formatPreciseTime } from "../../shared/utils/format";
import { SettingsNeonFrame } from "../settings/SettingsNeonFrame";
import { MeIcon, ReferenceArt } from "./EditorHeader";
import waveform from "./assets/melody-editor-waveform.svg?raw";

export const EditorTransport = ({ playing, position, duration, audioReady, onTogglePlay, onPositionChange }: {
  playing: boolean;
  position: number;
  duration: number;
  audioReady: boolean;
  onTogglePlay(): void;
  onPositionChange(value: number): void;
}) => {
  const max = Math.max(duration, 1);
  const [volume, setVolume] = useState(88);
  const [muted, setMuted] = useState(false);
  const percentage = `${Math.min(100, Math.max(0, position / max * 100))}%`;

  return (
    <section className="me-panel me-transport" aria-label="Транспорт">
      <SettingsNeonFrame order={0} />
      <button className="me-glass me-play" type="button" disabled={!audioReady} aria-label={playing ? "Пауза" : "Воспроизвести"} onClick={onTogglePlay}>
        <MeIcon name={playing ? "pause" : "play"} />
      </button>
      <span className="me-current-time">{formatPreciseTime(position)}</span>
      <div className="me-waveform">
        <ReferenceArt markup={waveform} />
        <input type="range" min={0} max={max} step={.01} value={Math.min(position, max)} aria-label="Позиция песни" onChange={event => onPositionChange(Number(event.target.value))} />
        <span className="me-wave-cursor" style={{ left: percentage }} />
      </div>
      <span className="me-total-time">{formatPreciseTime(duration)}</span>
      <div className="me-glass me-volume" style={{ "--level": `${muted ? 0 : volume}%` } as CSSProperties}>
        <button className="me-glass" id="me-mute" type="button" aria-label="Звук" aria-pressed={muted} onClick={() => setMuted(value => !value)}>
          <MeIcon name="volume" />
        </button>
        <input type="range" min={0} max={100} value={volume} aria-label="Громкость" onChange={event => { setVolume(Number(event.target.value)); setMuted(false); }} />
      </div>
      <div className="me-select me-wave-zoom">
        <MeIcon name="search" />
        <select aria-label="Масштаб волны" defaultValue="100"><option>75</option><option value="100">100%</option><option>125%</option><option>150%</option></select>
        <MeIcon name="chevron" className="me-chevron" />
      </div>
      <button className="me-glass me-transport-menu" type="button" aria-label="Меню"><MeIcon name="more" /></button>
    </section>
  );
};
