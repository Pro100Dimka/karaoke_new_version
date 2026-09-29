import type { SongDto } from "../../../contracts/models";
import { useMemo } from "react";
import { Card } from "../../../theme/ui";
import type { KaraokeState } from "../karaokeMachine";
import type { useKaraokeSession } from "../useKaraokeSession";
import { DisplayToggles } from "./DisplayToggles";
import { EffectPresets } from "./EffectPresets";
import { MasterVolume } from "./MasterVolume";
import { MixerPanel } from "./MixerPanel";
import { PracticeParameters } from "./PracticeParameters";
import { SongStrip } from "./SongStrip";
import { Transport } from "./Transport";
import type { NoteRange } from "./noteRange";
import { useVoiceEffects } from "./useVoiceEffects";
import { musicalKeyLabel } from "./musicalKey";
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

/**
 * The karaoke control surface. Top row: song strip, transport, master volume and scene layers.
 * Lower row: song channels, voice effects, practice parameters and effect presets.
 */
export const KaraokeConsole = ({ song, state, session, visible, hasNotes, hasLyrics, range, microphoneAvailable }: KaraokeConsoleProps) => {
  const effects = useVoiceEffects(
    session.noiseSuppression,
    state.kind !== "preparing",
    session.monitoring,
    session.effectValues,
    session.setEffectValues,
    session.pitchHz,
  );
  const locked = !session.interactive || session.practiceLocked;
  const seekLocked = !session.interactive;
  const keyLabel = useMemo(
    () => musicalKeyLabel(session.document?.key, session.keyShift, session.document?.notes ?? []),
    [session.document?.key, session.document?.notes, session.keyShift],
  );

  return (
    <Card as="aside" variant="laser" data-hidden={!visible || undefined} aria-hidden={!visible} tilt={false} className="karaokeConsolePanel" cardPanel={{ className: "karaokeConsoleGlass" }} cardContent={{ className: "karaokeConsoleContent" }}>
      <div className="consoleTopRow">
        <SongStrip song={song} position={session.position} duration={song.durationSeconds} locked={seekLocked} onSeek={seconds => void session.seek(seconds)} />
        <Transport
          state={state}
          position={session.position}
          duration={song.durationSeconds}
          seekLocked={seekLocked}
          onSeek={seconds => void session.seek(seconds)}
          onTogglePlay={() => void session.togglePlay()}
          onStop={() => void session.finishPerformance()}
        />
        <MasterVolume value={session.gains.master} onChange={value => void session.changeGain("master", value)} />
        <DisplayToggles
          showNotes={session.showNotes}
          showLyrics={session.showLyrics}
          autoHide={session.autoHideConsole}
          hasNotes={hasNotes}
          hasLyrics={hasLyrics}
          onShowNotes={session.setShowNotes}
          onShowLyrics={session.setShowLyrics}
          onAutoHide={session.setAutoHideConsole}
        />
      </div>
      <div className="consolePanels">
        <MixerPanel gains={session.gains} effects={effects.values} onEffectChange={(id, value) => void effects.change(id, value)} monitoring={session.monitoring} microphoneAvailable={microphoneAvailable} onGainChange={(channel, value) => void session.changeGain(channel, value)} onToggleMonitoring={() => void session.toggleMonitoring()} />
        <PracticeParameters
          speed={session.speed}
          baseBpm={session.document?.bpm}
          keyShift={session.keyShift}
          keyLabel={keyLabel}
          range={range}
          locked={locked}
          onSpeedChange={value => void session.changeSpeed(value)}
          onKeyChange={delta => void session.changeKey(delta)}
        />
        <EffectPresets selected={effects.preset} microphoneAvailable={microphoneAvailable} onSelect={preset => void effects.applyPreset(preset)} />
      </div>
    </Card>
  );
};
