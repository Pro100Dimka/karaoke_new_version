import { Card, IconButton, tr, useLocale } from "@neo-ui-kit/react";
import { useCallback, useMemo, useState } from "react";
import { readText, storageKey, writeText } from "../../../shared/storage/localStore";
import type { KaraokeState } from "../../../application/karaoke/karaokeMachine";
import type { SongDto } from "../../../contracts/models";
import { ru } from "../../../i18n/messages.ru";
import { DetachButton, DetachedPanel } from "../../../shared/ui/DetachedPanel";
import { useDetachedPanel } from "../../../shared/ui/useDetachedPanel";
import { useStoredPanelLayout } from "../../../shared/ui/useFloatingPanel";
import type { useKaraokeSession } from "../useKaraokeSession";
import { ConsoleFrame, consoleDesignHeight } from "./ConsoleFrame";
import { MasterVolume } from "./MasterVolume";
import { MixerPanel } from "./MixerPanel";
import { PracticeParameters } from "./PracticeParameters";
import { SongStrip } from "./SongStrip";
import { Transport } from "./Transport";
import "./console.css";
import { musicalKeyLabel } from "./musicalKey";
import type { NoteRange } from "./noteRange";
import { useVoiceEffects } from "./useVoiceEffects";

// Keep each orientation's layout fixed; ConsoleFrame fits the whole surface to its window.
const consoleWidths = { horizontal: 1144, vertical: 276 };
const consolePlacements = { top: "Горизонтально сверху", bottom: "Горизонтально снизу",
  left: "Вертикально слева", right: "Вертикально справа", free: "Свободное размещение" };
export type ConsolePlacement = keyof typeof consolePlacements;
const dockKey = storageKey("consoleDock");

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
 * Lower row: song channels, practice parameters and voice effects with preset selection.
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
  useLocale();
  const placement = useStoredPanelLayout("karaokeConsole");
  const [dock, setDock] = useState<ConsolePlacement>(() => {
    const saved = readText(dockKey);
    return saved && saved in consolePlacements ? saved as ConsolePlacement : placement.layout ? "free" : "bottom";
  });
  const [vertical, setVertical] = useState(() => ["left", "right"].includes(dock) ||
    (dock === "free" && !!placement.layout && placement.layout.height > placement.layout.width));
  const consoleWidth = consoleWidths[vertical ? "vertical" : "horizontal"];
  const changeDock = (next: ConsolePlacement) => {
    setDock(next);
    writeText(dockKey, next);
    if (next !== "free") setVertical(["left", "right"].includes(next));
  };
  // The size its own window opens with; the window then fits itself to the console's content.
  const consolePanelSize = useMemo(
    () => ({ width: consoleWidth, height: consoleDesignHeight }),
    [consoleWidth],
  );
  // The console is dragged anywhere by its surface, and past the window's edge into a window.
  const [presetsOpen, setPresetsOpen] = useState(false);
  const panel = useDetachedPanel(
    "karaokeConsole",
    tr(ru.karaokeConsole),
    consolePanelSize,
    (layout) => { placement.save(layout); changeDock("free"); },
  );
  // In a window of its own the console is always shown; auto-hide belongs to the karaoke screen.
  const shown = visible || panel.detached || presetsOpen;
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

  const changeMaster = useCallback((value: number) => { void session.changeGain("master", value); }, [session.changeGain]);
  const mixerProps = {
    gains: session.gains,
    effects: effects.values,
    onEffectChange: effects.change,
    monitoring: session.monitoring,
    microphoneAvailable,
    onGainChange: session.changeGain,
    onToggleMonitoring: session.toggleMonitoring,
    selectedPreset: effects.preset,
    presetsOpen,
    onPresetsOpenChange: setPresetsOpen,
    onPresetSelect: effects.applyPreset,
  };

  return (
    <DetachedPanel panel={panel} keepMounted>
      <ConsoleFrame
        panel={panel}
        placement={placement}
        dock={dock}
        vertical={vertical}
        onFloat={() => changeDock("free")}
        width={consoleWidth}
        shown={shown}
        label={tr(ru.karaokeConsole)}
      >
        <Card border shell padding="sm" className="karaokeConsoleCard">
          {Object.entries(consolePlacements).filter(([id]) => id !== "free" && (panel.detached || id !== dock)).map(([id, label]) => (
            <IconButton key={id} className="consoleDockButton" data-edge={id}
              size="xs" round icon="back" label={tr(label)} aria-pressed={dock === id && !panel.detached}
              onClick={() => { changeDock(id as ConsolePlacement); panel.attach(); }} />
          ))}
          <div className="consoleTopRow">
            <SongStrip
              song={song}
              position={shown ? session.position : 0}
              duration={song.durationSeconds}
              locked={seekLocked}
              playing={shown && state.kind === "playing"}
              onSeek={session.seek}
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
            <DetachButton panel={panel} size="xs" />
            <MasterVolume
              value={session.gains.master}
              onChange={changeMaster}
            />
          </div>
          <div className="consolePanels">
            <MixerPanel section="song" {...mixerProps} />
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
              onSpeedChange={session.changeSpeed}
              onKeyChange={session.changeKey}
            />
            <MixerPanel section="voice" {...mixerProps} />
          </div>
        </Card>
      </ConsoleFrame>
    </DetachedPanel>
  );
};
