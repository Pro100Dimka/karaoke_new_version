import type { SongDto } from "../../../contracts/models";
import { Card } from "../../../theme/ui";
import type { KaraokeState } from "../karaokeMachine";
import type { useKaraokeSession } from "../useKaraokeSession";
import { ConsoleCenter } from "./ConsoleCenter";
import { MixerPanel } from "./MixerPanel";
import { SongStrip } from "./SongStrip";
import { ToolsPanel } from "./ToolsPanel";
import type { NoteRange } from "./noteRange";
import { useVoiceEffects } from "./useVoiceEffects";
import "./console.css";

type KaraokeSession = ReturnType<typeof useKaraokeSession>;

interface KaraokeConsoleProps {
  song: SongDto;
  state: KaraokeState;
  session: KaraokeSession;
  visible: boolean;
  hasNotes: boolean;
  hasLyrics: boolean;
  range: NoteRange | null;
  microphoneAvailable: boolean;
}

/** The karaoke control surface: a glass panel with the song strip on top and mixer, transport and tools below. */
export const KaraokeConsole = ({ song, state, session, visible, hasNotes, hasLyrics, range, microphoneAvailable }: KaraokeConsoleProps) => {
  const effects = useVoiceEffects(session.noiseSuppression, state.kind !== "preparing", session.monitoring);
  const locked = session.locked || !session.interactive;
  const seekLocked = !session.interactive;

  return (
    <Card as="aside" variant="laser" data-hidden={!visible || undefined} aria-hidden={!visible} tilt={false} className="karaokeConsolePanel" cardPanel={{ className: "karaokeConsoleGlass" }} cardContent={{ className: "karaokeConsoleContent" }}>
      <SongStrip song={song} position={session.position} duration={song.durationSeconds} locked={seekLocked} onSeek={seconds => void session.seek(seconds)} />
      <div className="consoleColumns">
        <MixerPanel gains={session.gains} effects={effects.values} onEffectChange={(id, value) => void effects.change(id, value)} monitoring={session.monitoring} microphoneAvailable={microphoneAvailable} onGainChange={(channel, value) => void session.changeGain(channel, value)} onToggleMonitoring={() => void session.toggleMonitoring()} />
        <ConsoleCenter
          state={state}
          position={session.position}
          duration={song.durationSeconds}
          speed={session.speed}
          keyShift={session.keyShift}
          range={range}
          locked={locked}
          seekLocked={seekLocked}
          onSeek={seconds => void session.seek(seconds)}
          onTogglePlay={() => void session.togglePlay()}
          onStop={() => void session.finishPerformance()}
          onSpeedChange={value => void session.changeSpeed(value)}
          onKeyChange={delta => void session.changeKey(delta)}
        />
        <ToolsPanel
          showNotes={session.showNotes}
          showLyrics={session.showLyrics}
          autoHide={session.autoHideConsole}
          hasNotes={hasNotes}
          hasLyrics={hasLyrics}
          microphoneAvailable={microphoneAvailable}
          effectPreset={effects.preset}
          onEffectPreset={preset => void effects.applyPreset(preset)}
          onShowNotes={session.setShowNotes}
          onShowLyrics={session.setShowLyrics}
          onAutoHide={session.setAutoHideConsole}
        />
      </div>
    </Card>
  );
};
