import { Card } from "@ad-voice/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SongDto } from "../../../contracts/models";
import { useText } from "../../../i18n/useText";
import { DetachButton, DetachedPanel } from "../../../shared/ui/DetachedPanel";
import { useDetachedPanel } from "../../../shared/ui/useDetachedPanel";
import {
  useFloatingPanel,
  useStoredPanelLayout,
} from "../../../shared/ui/useFloatingPanel";
import type { KaraokeState } from "../karaokeMachine";
import type { useKaraokeSession } from "../useKaraokeSession";
import { EffectPresets } from "./EffectPresets";
import { MasterVolume } from "./MasterVolume";
import { MixerPanel } from "./MixerPanel";
import { PracticeParameters } from "./PracticeParameters";
import { SongStrip } from "./SongStrip";
import { Transport } from "./Transport";
import "./console.css";
import { musicalKeyLabel } from "./musicalKey";
import type { NoteRange } from "./noteRange";
import { useVoiceEffects } from "./useVoiceEffects";

// The console is 90vw wide and short, like the console strip on the karaoke screen. Panels are laid out in pixels,
// so the share of the window is turned into pixels and followed as the window is resized.
const consoleWidthShare = 0.9;
const consoleHeight = 320;

const useViewportShare = (share: number): number => {
  const [width, setWidth] = useState(() =>
    Math.round(window.innerWidth * share),
  );
  useEffect(() => {
    const follow = () => setWidth(Math.round(window.innerWidth * share));
    window.addEventListener("resize", follow);
    return () => window.removeEventListener("resize", follow);
  }, [share]);
  return width;
};

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
export const KaraokeConsole = ({
  song,
  state,
  session,
  visible,
  hasNotes,
  hasLyrics,
  range,
  microphoneAvailable,
}: KaraokeConsoleProps) => {
  const effects = useVoiceEffects(
    session.effectValues,
    session.setEffectValues,
  );
  const t = useText();
  const consoleWidth = useViewportShare(consoleWidthShare);
  const consolePanelSize = useMemo(
    () => ({ width: consoleWidth, height: consoleHeight }),
    [consoleWidth],
  );
  // The console is dragged anywhere by its surface, and past the window's edge into a window.
  const placement = useStoredPanelLayout("karaokeConsole");
  const panel = useDetachedPanel(
    "karaokeConsole",
    t("karaokeConsole"),
    consolePanelSize,
    placement.save,
  );
  const frameRef = useRef<HTMLElement>(null);
  const floating = useFloatingPanel(frameRef, {
    // The console has no resize handles: only its place is kept, its size is always the designed one
    // (squeezed by a small window, back to full when the window grows).
    layout: placement.layout && { ...placement.layout, ...consolePanelSize },
    onLayoutChange: placement.save,
    defaultSize: consolePanelSize,
    onDragOutside: (bounds, pointer) => panel.detach(bounds, pointer),
  });
  const floatingStyle =
    !panel.detached && floating.layout
      ? {
          position: "fixed" as const,
          left: floating.layout.left,
          top: floating.layout.top,
          inlineSize: floating.layout.width,
        }
      : undefined;
  // In a window of its own the console is always shown; auto-hide belongs to the karaoke screen.
  const shown = visible || panel.detached;
  const locked = !session.interactive || session.practiceLocked;
  const seekLocked = !session.interactive;
  const keyLabel = useMemo(
    () =>
      musicalKeyLabel(
        session.document?.key,
        session.keyShift,
        session.document?.notes ?? [],
      ),
    [session.document?.key, session.document?.notes, session.keyShift],
  );

  return (
    <DetachedPanel panel={panel}>
      <aside
        className="karaokeConsolePanel"
        aria-label={t("karaokeConsole")}
        data-hidden={!shown || undefined}
        aria-hidden={!shown}
        ref={frameRef}
        style={floatingStyle}
        onPointerDown={panel.detached ? undefined : floating.beginMove}
        onPointerMove={panel.detached ? undefined : floating.handleMove}
        onPointerUp={panel.detached ? undefined : floating.handleUp}
      >
        <Card border shell padding="sm" className="karaokeConsoleCard">
          <div className="consoleTopRow">
            <SongStrip
              song={song}
              position={session.position}
              duration={song.durationSeconds}
              locked={seekLocked}
              playing={state.kind === "playing"}
              onSeek={(seconds) => void session.seek(seconds)}
            />
            <Transport
              state={state}
              position={session.position}
              duration={song.durationSeconds}
              seekLocked={seekLocked}
              onSeek={(seconds) => void session.seek(seconds)}
              onTogglePlay={() => void session.togglePlay()}
              onStop={() => void session.finishPerformance()}
            />
            <DetachButton panel={panel} />
            <MasterVolume
              value={session.gains.master}
              onChange={(value) => void session.changeGain("master", value)}
            />
          </div>
          <div className="consolePanels">
            <MixerPanel
              gains={session.gains}
              effects={effects.values}
              onEffectChange={(id, value) => void effects.change(id, value)}
              monitoring={session.monitoring}
              microphoneAvailable={microphoneAvailable}
              onGainChange={(channel, value) =>
                void session.changeGain(channel, value)
              }
              onToggleMonitoring={() => void session.toggleMonitoring()}
            />
            <PracticeParameters
              speed={session.speed}
              baseBpm={session.document?.bpm}
              keyShift={session.keyShift}
              keyLabel={keyLabel}
              range={range}
              hasNotes={hasNotes}
              hasLyrics={hasLyrics}
              showNotes={session.showNotes}
              showLyrics={session.showLyrics}
              autoHideConsole={session.autoHideConsole}
              setShowNotes={session.setShowNotes}
              setShowLyrics={session.setShowLyrics}
              setAutoHideConsole={session.setAutoHideConsole}
              locked={locked}
              onSpeedChange={(value) => void session.changeSpeed(value)}
              onKeyChange={(delta) => void session.changeKey(delta)}
            />
            <EffectPresets
              selected={effects.preset}
              microphoneAvailable={microphoneAvailable}
              onSelect={(preset) => void effects.applyPreset(preset)}
            />
          </div>
        </Card>
      </aside>
    </DetachedPanel>
  );
};
