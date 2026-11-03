import {
  Dialog,
  Form,
  FormFields,
  tr,
  useForm,
  useLocale,
  useRouter,
} from '@neo-ui-kit/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { refreshSongs } from '../../../../api/api-service';
import { desktopClient as files } from '../../../../services/desktopClient';
import { pythonClient } from '../../../../services/pythonClient';
import { useGuardedAction } from '../../songs/useGuardedAction';
import { useSongActions } from '../../songs/useSongActions';

import {
  loadSongPreferences,
  saveSongPreferences,
} from '../../../../application/library/songPreferences';
import type { SongDto } from '../../../../contracts/models';
import '../../../../providers/localization';
import { routes } from '../../../../shared/routes';
import { editorApi } from '../../../editor/editorApi';
import { getRows } from './rows';

const coverLabel = {
  Custom: 'coverCustom',
  Embedded: 'coverEmbedded',
  Fallback: 'coverFallback',
} as const;
export const SongSettingsModal = ({
  song,
  onClose,
  onChange,
}: {
  song: SongDto;
  onClose(): void;
  onChange(song: SongDto): void;
}) => {
  const client = useQueryClient();
  const guarded = useGuardedAction();
  const { confirmDelete } = useSongActions(onClose);
  const onRemoveCover = (target: SongDto) =>
    guarded(async () => {
      const saved = await pythonClient.removeSongCover(target.id);
      onChange(saved);
      await refreshSongs(client);
    });
  const { navigate } = useRouter();
  useLocale();
  const coverState = tr(
    song.artworkUrl && song.coverState === 'Fallback'
      ? 'coverOnline'
      : coverLabel[song.coverState],
  );
  const { data: document } = useQuery({
    queryKey: ['song-settings-document', song.id, song.activeRevision],
    queryFn: () => editorApi.load(song.id),
    enabled: song.status === 'ready',
  });
  const [failure, setFailure] = useState<string>();
  const form = useForm({
    initialValues: {
      title: song.title,
      artist: song.artist,
      language: song.language,
      coverPath: '',
      videoPath: '',
      ...loadSongPreferences(song.id),
    },
    reinitialize: false,
    onSubmit: async (values) => {
      setFailure(undefined);
      try {
        const { title, artist, language, coverPath, videoPath, ...local } =
          values;
        await pythonClient.updateSong(song.id, {
          title: title.trim() || undefined,
          artist: artist.trim() || undefined,
          language,
          coverPath: coverPath || undefined,
          videoPath: videoPath || undefined,
        });
        saveSongPreferences(song.id, {
          ...local,
          videoUrl: videoPath ? '' : local.videoUrl,
        });
        await refreshSongs(client);
        onClose();
      } catch (error) {
        setFailure(error instanceof Error ? error.message : String(error));
      }
    },
  });
  const [selected, setSelected] = useState<{ cover?: File; video?: File }>({});
  const [previews, setPreviews] = useState<{ cover?: string; video?: string }>(
    {},
  );
  useEffect(() => {
    const cover = selected.cover && URL.createObjectURL(selected.cover);
    const video = selected.video && URL.createObjectURL(selected.video);
    setPreviews({ cover, video });
    return () => {
      if (cover) URL.revokeObjectURL(cover);
      if (video) URL.revokeObjectURL(video);
    };
  }, [selected]);
  const chooseMedia = (kind: 'cover' | 'video', file: File | undefined) => {
    if (!file) return;
    form.setValue(
      kind === 'cover' ? 'coverPath' : 'videoPath',
      files.pathForFile(file),
    );
    setSelected((current) => ({ ...current, [kind]: file }));
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      className="songSettingsDialog"
      width="large"
      icon="settings"
      title={tr('songSettings')}
      description={`${song.artist} — ${song.title}`}
      closeLabel={tr('closeDialog')}
      cancelLabel={false}
      confirmLabel={false}
    >
      <Form form={form} className="songSettingsForm">
        <FormFields
          fields={getRows({
            song,
            document,
            coverState,
            selected,
            previews,
            chooseMedia,
            failure,
            onEdit: () => {
              onClose();
              navigate(routes.editor(song.id));
            },
            onRemoveCover: () => void onRemoveCover(song),
            onDelete: () => void confirmDelete(song),
          })}
          gap={4}
        />
      </Form>
    </Dialog>
  );
};
