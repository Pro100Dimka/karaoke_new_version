import { openSettings } from '../pages/library/modals/settings';
import { observer } from 'mobx-react-lite';
import {
  Button,
  Icon,
  IconButton,
  Popover,
  SegmentedControl,
  Slider,
  TextField,
  tr,
  useLocale,
  useRouter,
} from '@neo-ui-kit/react';
import { useEffect, useRef, useState } from 'react';
import { routes } from '../shared/routes';
import { store } from '../providers/store';
import {
  changeRadioStation,
  setRadioStation,
  setRadioVolume,
  setYoutubePlaylist,
  toggleRadio,
} from '../providers/radio';
import { useRadioTrack } from './desktop/shellBus';
import {
  radioStations,
  youtubeSource,
  youtubeSourceFromUrl,
} from './radioStations';
import { volumeFromKnob, volumeToKnob } from '../shared/utils/mixerLevel';

/** Library music controls share one source selector and one volume. */
export const FloatingControls = observer(() => {
  useLocale();
  const { navigate } = useRouter();
  const radio = store.radio;
  const stationTrack = useRadioTrack();
  const youtube = youtubeSource(radio.stationId);
  const station =
    radioStations.find((item) => item.id === radio.stationId) ??
    radioStations[0];
  const track = youtube ? radio.youtubeTrack : stationTrack;
  const playlistPosition =
    youtube && radio.youtubeTrack
      ? `${radio.youtubeTrack.index}${radio.youtubeTrack.count ? ` / ${radio.youtubeTrack.count}` : ''}`
      : null;
  const trackDetails =
    [track?.artist, playlistPosition].filter(Boolean).join(' · ') ||
    tr(youtube ? 'radioPlaylistSource' : 'radioLiveStream');
  const radioAnchor = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<'radio' | 'youtube'>(
    youtube ? 'youtube' : 'radio',
  );
  const [playlistUrl, setPlaylistUrl] = useState(
    store.preferences.radioYoutubePlaylist,
  );
  const [invalidUrl, setInvalidUrl] = useState(false);
  const playlistId = youtube?.playlistId;
  const playlistIndex = youtube?.index;
  useEffect(() => {
    setSource(playlistId ? 'youtube' : 'radio');
    if (playlistId)
      setPlaylistUrl(
        `https://www.youtube.com/playlist?list=${playlistId}&index=${playlistIndex}`,
      );
  }, [playlistId, playlistIndex]);
  const openPlayer = () => {
    setSource(youtube ? 'youtube' : 'radio');
    setOpen(true);
  };

  const transport = [
    {
      key: 'previous',
      icon: 'prev',
      label: tr(youtube ? 'radioPreviousTrack' : 'radioPreviousStation'),
      variant: 'ghost',
      disabled: !radio.canControl || radio.loading,
      onClick: () => changeRadioStation(-1),
    },
    {
      key: 'play',
      icon: radio.enabled ? 'pause' : 'play',
      label: tr(radio.enabled ? 'radioPause' : 'radioPlay'),
      variant: 'primary',
      size: 'lg',
      round: true,
      disabled: !radio.canControl,
      onClick: toggleRadio,
    },
    {
      key: 'next',
      icon: 'prev',
      className: 'radioNext',
      label: tr(youtube ? 'radioNextTrack' : 'radioNextStation'),
      variant: 'ghost',
      disabled: !radio.canControl || radio.loading,
      onClick: () => changeRadioStation(1),
    },
  ] as const;

  return (
    <aside className="floatingControls" aria-label={tr('settings')}>
      <div
        className="radioLauncher"
        ref={radioAnchor}
        data-playing={radio.enabled && !radio.loading}
      >
        <IconButton
          round
          size="lg"
          icon="radio"
          label={tr('radio')}
          aria-expanded={open}
          aria-haspopup="dialog"
          variant={radio.enabled ? 'primary' : 'ghost'}
          onClick={() => (open ? setOpen(false) : openPlayer())}
        />
        <Popover
          open={open}
          onOpenChange={setOpen}
          anchorRef={radioAnchor}
          align="end"
          autoFocus={false}
          label={tr('radioControls')}
          className="radioPopover"
        >
          <div className="radioPlayerHeader">
            <span className="radioPlayerEyebrow">{tr('radioPlayer')}</span>
            <IconButton
              size="sm"
              variant="ghost"
              icon="close"
              label={tr('close')}
              onClick={() => setOpen(false)}
            />
          </div>
          <section className="radioPlayerDeck" aria-label={tr('radioPlayback')}>
            <div className="radioNowPlaying" aria-live="polite">
              <div className="radioArtwork">
                <Icon name={youtube ? 'list' : 'wave'} size="md" />
              </div>
              <div className="radioNowPlayingText">
                <span
                  className="radioNowPlayingSource"
                  title={
                    youtube ? radio.youtubeTrack?.playlistTitle : station?.name
                  }
                >
                  {youtube
                    ? (radio.youtubeTrack?.playlistTitle ?? 'YouTube')
                    : station?.name}
                </span>
                <strong title={track?.title}>
                  {track?.title ||
                    (youtube ? tr('radioPlaylistSource') : station?.genre)}
                </strong>
                <span
                  className="radioStatus"
                  data-playing={radio.enabled && !radio.loading}
                >
                  <i />
                  {tr(
                    radio.loading
                      ? 'radioLoading'
                      : radio.enabled
                        ? 'radioPlaying'
                        : 'radioPaused',
                  )}
                  {track && ` · ${trackDetails}`}
                </span>
              </div>
            </div>
            <div
              className="radioTransport"
              role="group"
              aria-label={tr('radioPlayback')}
            >
              {transport.map(({ key, ...control }) => (
                <IconButton key={key} {...control} />
              ))}
            </div>
            <div className="radioVolume">
              <Icon name="volume" />
              <Slider
                aria-label={tr('radioVolume')}
                min={0}
                max={100}
                value={volumeToKnob(radio.volume / 100) * 100}
                onValueChange={(value) =>
                  setRadioVolume(volumeFromKnob(value / 100) * 100)
                }
              />
              <output>
                {Math.round(volumeToKnob(radio.volume / 100) * 100)}%
              </output>
            </div>
            {radio.error && (
              <p className="radioError" role="alert">
                {tr(youtube ? 'radioYoutubeUnavailable' : 'radioUnavailable')}
              </p>
            )}
          </section>
          <SegmentedControl
            size="sm"
            value={source}
            label={tr('radioSource')}
            items={[
              { value: 'radio', label: tr('radio'), icon: 'radio' },
              { value: 'youtube', label: 'YouTube', icon: 'list' },
            ]}
            onValueChange={(value) => {
              setSource(value);
              setInvalidUrl(false);
              const selected =
                value === 'radio'
                  ? store.preferences.radioBroadcastStation ||
                    radioStations[0]?.id
                  : youtubeSourceFromUrl(
                      store.preferences.radioYoutubePlaylist,
                    );
              if (selected) setRadioStation(selected);
            }}
          />
          <div className="radioSourceControls">
            {source === 'radio' ? (
              <div
                className="radioStationGrid"
                role="group"
                aria-label={tr('radioStation')}
              >
                {radioStations.map(({ id, name, genre }) => (
                  <Button
                    key={id}
                    className="radioStationChoice"
                    variant="ghost"
                    aria-pressed={!youtube && station?.id === id}
                    disabled={!radio.canControl}
                    onClick={() => setRadioStation(id)}
                  >
                    <span className="radioStationName">{name}</span>
                    <span className="radioStationGenre">{genre}</span>
                  </Button>
                ))}
              </div>
            ) : (
              <form
                className="radioPlaylistForm"
                onSubmit={(event) => {
                  event.preventDefault();
                  setInvalidUrl(!setYoutubePlaylist(playlistUrl));
                }}
              >
                <TextField
                  label={tr('radioPlaylistUrl')}
                  placeholder="https://youtube.com/playlist?list=…"
                  value={playlistUrl}
                  type="url"
                  disabled={!radio.canControl}
                  onValueChange={(value) => {
                    setPlaylistUrl(value);
                    setInvalidUrl(false);
                  }}
                  error={invalidUrl ? tr('radioPlaylistInvalid') : undefined}
                />
                <p className="radioHint">{tr('radioPlaylistHint')}</p>
                <Button
                  type="submit"
                  icon="play"
                  variant="primary"
                  size="sm"
                  loading={radio.loading && Boolean(youtube)}
                  disabled={!radio.canControl || !playlistUrl.trim()}
                >
                  {tr('radioUsePlaylist')}
                </Button>
              </form>
            )}
          </div>
        </Popover>
      </div>
      {[
        {
          icon: 'settings',
          label: tr('settings'),
          onClick: () => openSettings(),
        },
        {
          icon: 'info',
          label: tr('Инструкция'),
          onClick: () => navigate(routes.help),
        },
      ].map((control) => (
        <IconButton
          key={control.icon}
          round
          size="lg"
          variant="ghost"
          {...control}
        />
      ))}
    </aside>
  );
});
