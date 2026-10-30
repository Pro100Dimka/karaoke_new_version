import { useQueryClient } from "@tanstack/react-query";
import { pythonClient } from "../../../../../services/pythonClient";
import { desktopClient } from "../../../../../services/desktopClient";
import { refreshSongs } from "../../../../../api/api-service";
import { useSongActions } from "../../useSongActions";
import { ask } from "../../../../../providers/dialog";
import { useGuardedAction } from "../../useGuardedAction";
import {
  Badge,
  Card,
  Checkbox,
  Grid,
  Icon,
  IconButton,
  ProgressBar,
  Stack,
  Typography,
  tr,
  useLocale,
} from "@neo-ui-kit/react";
import { memo, useState } from "react";
import type { SongDto } from "../../../../../contracts/models";
import type { MessageKey } from "../../../../../i18n/messages";
import { ru } from "../../../../../i18n/messages.ru";
import {
  songStatusPresentation,
  type SongActionId,
} from "../../songPresentation";
import { ProcessingSignal } from "./processing-signal";

const actionMeta = {
  play: { label: "play", icon: "play" },
  cancelQueued: { label: "cancelQueueItem", icon: "stop" },
  processingDetails: { label: "openProcessingDetails", icon: "processing" },
  recordings: { label: "recordings", icon: "headphones" },
  settings: { label: "songSettings", icon: "settings" },
  folder: { label: "openFolder", icon: "folder" },
  viewError: { label: "viewError", icon: "warning" },
  delete: { label: "deleteSong", icon: "trash" },
} as const satisfies Record<SongActionId, { label: MessageKey; icon: string }>;

/** The primary button's icon: in a room a guest picks songs, otherwise it is the song's main action. */
const primaryIcon = (
  primary: SongActionId | null,
  roomSelection?: { role: string; selected: boolean },
) => {
  if (roomSelection && roomSelection.role !== "host")
    return roomSelection.selected ? "check" : "users";
  return primary ? actionMeta[primary].icon : "processing";
};

export const SongCard = memo(
  function SongCard({
    song,
    onPlay,
    onOpenProcessing,
    onOpenSettings,
    onOpenRecordings,
    roomSelection,
    playbackDisabled = false,
    selection,
  }: {
    song: SongDto;
    onPlay(song: SongDto, rehearsal?: boolean): void;
    onOpenProcessing(songId: string): void;
    onOpenSettings(song: SongDto): void;
    onOpenRecordings(song: SongDto): void;
    roomSelection?: { role: string; selected: boolean };
    playbackDisabled?: boolean;
    selection?: { checked: boolean; disabled: boolean; toggle(): void };
  }) {
    useLocale();
    const client = useQueryClient();
    const guarded = useGuardedAction();
    const { confirmDelete } = useSongActions();
    const showError = async () => {
      let message = tr(ru.errorProjectInvalid);
      try {
        const failed = (await pythonClient.listJobs()).find(job => job.songId === song.id && job.error);
        if (failed?.error) message = `${failed.error.code}: ${failed.error.message}`;
      } catch {
        // Keep the generic explanation when job details are unavailable.
      }
      await ask({ title: `${song.artist} — ${song.title}`, body: message,
        actions: [{ id: "ok", label: tr(ru.close), appearance: "primary" }] });
    };
    const [failedArtwork, setFailedArtwork] = useState<string | null>(null);
    const presentation = songStatusPresentation[song.status];
    const allowed: readonly SongActionId[] = song.roomOwnerId ? ["play"] : presentation.actions;
    const actions = {
      play: () => onPlay(song),
      cancelQueued: () => void guarded(async () => {
        if (!song.jobId) return;
        await pythonClient.cancelProcessing(song.jobId);
        await refreshSongs(client);
      }),
      processingDetails: () => onOpenProcessing(song.id),
      recordings: () => onOpenRecordings(song),
      settings: () => onOpenSettings(song),
      folder: () => void desktopClient.revealProject(song.id, song.activeRevision),
      viewError: () => void showError(),
      delete: () => void confirmDelete(song),
    } satisfies Record<SongActionId, () => void>;
    const primary = presentation.primaryAction;

    return (
      <Card
        role="listitem"
        border
        padding="sm"
        style={{ height: "100%" }}
        aria-label={`${song.artist} — ${song.title}`}
      >
        <Grid
          columns="30% minmax(0, 1fr)"
          gap={3}
          align="center"
          style={{ height: "100%" }}
        >
          <Stack
            align="center"
            justify="center"
            style={{
              aspectRatio: "1",
              overflow: "hidden",
              borderRadius: "calc(var(--ad-radius) * 0.6)",
              background: "var(--ad-neutral-900)",
              color: "var(--ad-muted)",
            }}
          >
            {song.artworkUrl && song.artworkUrl !== failedArtwork ? (
              <img
                src={song.artworkUrl}
                alt=""
                loading="lazy"
                decoding="async"
                onError={() => setFailedArtwork(song.artworkUrl ?? null)}
                style={{
                  display: "block",
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                }}
              />
            ) : (
              <Icon name="music" size={36} />
            )}
          </Stack>
          <Stack gap={2} style={{ minWidth: 0, height: "100%" }}>
            <Stack gap={1}>
              {selection && (
                <Checkbox
                  checked={selection.checked}
                  disabled={selection.disabled}
                  label={tr("Выбрать {name}", { name: song.title })}
                  onValueChange={selection.toggle}
                />
              )}
              <Typography as="h2" variant="title" truncate>
                {song.title}
              </Typography>
              {song.artist && (
                <Typography variant="body-sm" tone="muted" truncate>
                  {song.artist}
                </Typography>
              )}
            </Stack>
            <Badge size="sm" tone={presentation.tone} style={{ alignSelf: "start" }}>
              {tr(ru[presentation.label])}
            </Badge>
            <Stack
              direction="row"
              align="center"
              wrap
              gap={2}
              style={{ marginTop: "auto", minWidth: 0 }}
            >
              {allowed.map((id) => (
                <IconButton
                  key={id}
                  round
                  size="sm"
                  style={{ flexShrink: 0 }}
                  icon={
                    id === primary
                      ? primaryIcon(primary, roomSelection)
                      : actionMeta[id].icon
                  }
                  label={tr(ru[actionMeta[id].label])}
                  variant={id === primary ? "primary" : "ghost"}
                  disabled={id === "play" && playbackDisabled}
                  onClick={actions[id]}
                />
              ))}
              {
                !roomSelection &&
                song.status === "ready" && (
                  <IconButton
                    round
                    size="sm"
                    variant="ghost"
                    icon="music"
                    style={{ flexShrink: 0 }}
                    label={tr(ru["recordingRehearsal"])}
                    disabled={playbackDisabled}
                    onClick={() => onPlay(song, true)}
                  />
                )}
              {song.status === "processing" && (
                <ProcessingSignal progress={song.progress ?? 0} song={song} />
              )}
              {song.status === "importing" && (
                <ProgressBar
                  value={song.progress ?? 0}
                  label={tr(ru.importing)}
                />
              )}
            </Stack>
          </Stack>
        </Grid>
      </Card>
    );
  },
  (previous, next) =>
    previous.song === next.song &&
    previous.onPlay === next.onPlay &&
    previous.onOpenProcessing === next.onOpenProcessing &&
    previous.onOpenSettings === next.onOpenSettings &&
    previous.onOpenRecordings === next.onOpenRecordings &&
    previous.playbackDisabled === next.playbackDisabled &&
    previous.selection === next.selection &&
    previous.roomSelection?.role === next.roomSelection?.role &&
    previous.roomSelection?.selected === next.roomSelection?.selected,
);
