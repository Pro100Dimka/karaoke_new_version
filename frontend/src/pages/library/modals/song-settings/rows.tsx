import {
  Button,
  MessageBar,
  SplitButton,
  tr,
  Typography,
  type FormFieldDefinition,
} from '@neo-ui-kit/react';
import { useRef, type ReactNode } from 'react';
import type { EditorDocument } from '../../../../application/editor/editorModel';
import type { SongPreferences } from '../../../../application/library/songPreferences';
import type { SongDto } from '../../../../contracts/models';
import { TempoField } from '../../../../features/karaoke/console/PracticeParameters';
import { musicalKeyLabel } from '../../../../features/karaoke/console/musicalKey';
import { desktopClient as files } from '../../../../services/desktopClient';
import { languageLabels } from '../../songs/songMetadataPresentation';

const MediaField = ({
  title,
  buttonLabel,
  icon,
  accept,
  caption,
  onChoose,
  children,
}: {
  title: string;
  buttonLabel: string;
  icon: string;
  accept: string;
  caption: string;
  onChoose(file: File | undefined): void;
  children: ReactNode;
}) => {
  const input = useRef<HTMLInputElement>(null);
  return (
    <section className="songSettingsMedia">
      <div className="songSettingsMediaHeader">
        <Typography as="h3" variant="body">
          {title}
        </Typography>
        <Button
          size="sm"
          icon={icon}
          label={buttonLabel}
          onClick={() => input.current?.click()}
        />
      </div>
      <input
        hidden
        ref={input}
        type="file"
        accept={accept}
        onChange={(event) => onChoose(event.target.files?.[0])}
      />
      <div className="songSettingsMediaPreview">{children}</div>
      <Typography
        variant="caption"
        tone="muted"
        className="songSettingsMediaName"
      >
        {caption}
      </Typography>
    </section>
  );
};

type SongSettingsValues = {
  [K in keyof SongPreferences]: SongPreferences[K];
} & Pick<SongDto, 'title' | 'artist' | 'language'> & {
    coverPath: string;
    videoPath: string;
  };

type TRows = {
  failure: string | undefined;
  onEdit(): void;
  onRemoveCover(): void;
  onDelete(): void;
  song: SongDto;
  document: EditorDocument | undefined;
  coverState: string;
  selected: { cover?: File; video?: File };
  previews: { cover?: string; video?: string };
  chooseMedia(kind: 'cover' | 'video', file: File | undefined): void;
};

export const getRows = ({
  song,
  document,
  coverState,
  selected,
  previews,
  chooseMedia,
  failure,
  onEdit,
  onRemoveCover,
  onDelete,
}: TRows): FormFieldDefinition<SongSettingsValues>[] => {
  const video = song.videoUrl?.includes(
    `/songs/${encodeURIComponent(song.id)}/clip`,
  )
    ? song.videoUrl
    : undefined;

  const bpm = document?.bpm ?? song.detectedBpm;
  const baseBpm =
    typeof bpm === 'number' && Number.isFinite(bpm) && bpm > 0 ? bpm : null;
  const span = { base: 12, md: 4 };
  return [
    { name: 'title', label: tr('title'), span },
    { name: 'artist', label: tr('artist'), span },
    {
      name: 'language',
      kind: 'select',
      label: tr('songLanguage'),
      span,
      props: {
        options: Object.entries(languageLabels).map(([value, label]) => ({
          value,
          label: tr(label),
        })),
      },
    },
    {
      name: 'defaultKey',
      kind: 'select',
      label: tr('keyTranspose'),
      span,
      props: {
        options: Array.from({ length: 25 }, (_, index) => {
          const shift = index - 12;
          const key = musicalKeyLabel(
            document?.key ?? song.detectedKey,
            shift,
            document?.notes ?? [],
          );
          return {
            value: shift,
            label: `${key} · ${shift > 0 ? '+' : ''}${shift}`,
          };
        }),
      },
    },
    {
      name: 'defaultSpeed',
      kind: 'custom',
      span,
      render: (field, form) => (
        <TempoField
          label={tr('practiceSpeed')}
          baseBpm={baseBpm}
          tempoBpm={
            baseBpm === null
              ? null
              : Math.round(baseBpm * form.values.defaultSpeed)
          }
          locked={false}
          onChange={field.onValueChange}
        />
      ),
    },
    {
      name: 'vocalRange',
      kind: 'select',
      label: tr('defaultVocalRange'),
      span,
      props: {
        options: Object.entries({
          auto: 'rangeAuto',
          octave: 'rangeOctave',
          twoOctaves: 'rangeTwoOctaves',
        }).map(([value, label]) => ({ value, label: tr(label) })),
      },
    },
    {
      name: 'coverPath',
      kind: 'custom',
      span: { base: 12, md: 6 },
      render: () => (
        <MediaField
          title={tr('coverArtwork')}
          buttonLabel={tr('replaceCover')}
          icon="photo"
          accept="image/png,image/jpeg,image/webp"
          caption={selected.cover?.name || coverState}
          onChoose={(file) => chooseMedia('cover', file)}
        >
          {previews.cover || song.artworkUrl ? (
            <img
              src={previews.cover || song.artworkUrl}
              alt={`${song.artist} � ${song.title}`}
            />
          ) : (
            <Typography tone="muted">{coverState}</Typography>
          )}
        </MediaField>
      ),
    },
    {
      name: 'videoPath',
      kind: 'custom',
      span: { base: 12, md: 6 },
      render: () => (
        <MediaField
          title={tr('savedSongVideo')}
          buttonLabel={tr('selectFile')}
          icon="folder"
          accept="video/mp4,.mp4"
          caption={
            selected.video?.name || (video ? tr('savedSongVideoReady') : 'MP4')
          }
          onChoose={(file) => chooseMedia('video', file)}
        >
          {previews.video || video ? (
            <video
              key={previews.video || video}
              src={previews.video || video}
              controls
              preload="metadata"
              playsInline
            />
          ) : (
            <Typography tone="muted">{tr('savedSongVideoMissing')}</Typography>
          )}
        </MediaField>
      ),
    },
    {
      name: 'failure',
      kind: 'custom',
      span: 'full',
      showWhen: () => !!failure,
      render: () => <MessageBar tone="error">{failure}</MessageBar>,
    },
    {
      name: 'actions',
      kind: 'custom',
      span: 'full',
      render: (_, form) => (
        <div className="songSettingsActions">
          <Button
            size="sm"
            icon="note"
            disabled={song.status !== 'ready'}
            onClick={onEdit}
            label={tr('melodyEditor')}
          />
          <SplitButton
            size="sm"
            icon="folder"
            label={tr('openFolder')}
            onClick={() =>
              void files.revealProject(song.id, song.activeRevision)
            }
            items={[
              {
                id: 'detected',
                label: tr('useDetectedValue'),
                showWhen: song.detectedBpm !== undefined || !!song.detectedKey,
                onSelect: () => {
                  form.setValue('defaultKey', 0);
                  form.setValue('defaultSpeed', 1);
                },
              },
              {
                id: 'cover',
                label: tr('removeCustomCover'),
                showWhen: song.coverState === 'Custom',
                onSelect: onRemoveCover,
              },
              {
                id: 'separator',
                separator: true,
                showWhen:
                  song.detectedBpm !== undefined ||
                  !!song.detectedKey ||
                  song.coverState === 'Custom',
              },
              {
                id: 'delete',
                label: tr('deleteSong'),
                icon: 'trash',
                danger: true,
                disabled: ['queued', 'processing'].includes(song.status),
                onSelect: onDelete,
              },
            ].filter((item) => item.showWhen !== false)}
          />
          <Button
            type="submit"
            variant="primary"
            icon="save"
            loading={form.submitting}
            label={tr('save')}
          />
        </div>
      ),
    },
  ];
};
