import { openSettings } from "../pages/library/modals/settings";
import { observer } from "mobx-react-lite";
import { Icon, IconButton, Popover, Slider, tr, useLocale, useRouter } from "@neo-ui-kit/react";

import { routes } from "../shared/routes";
import { useRef, useState } from "react";
import { ru } from "../i18n/messages.ru";
import { store } from "../providers/store";
import { toggleRadio, setRadioVolume } from "../providers/radio";
import { useRadioTrack } from "./desktop/shellBus";

/** The radio and settings buttons in the lower corner; the radio's volume opens on hover. */
export const FloatingControls = observer(() => {
  useLocale();
  const { navigate } = useRouter();
  const radio = store.radio;
  const track = useRadioTrack();
  const el = (
    <IconButton
      round
      size="lg"
      variant="ghost"
      icon="settings"
      label={tr(ru.settings)}
      onClick={() => openSettings()}
    />
  );
  const radioAnchor = useRef<HTMLButtonElement>(null);
  const [volumeOpen, setVolumeOpen] = useState(false);

  return (
    <aside className="floatingControls" aria-label={tr(ru.settings)}>
      <div
        onMouseEnter={() => radio.enabled && setVolumeOpen(true)}
        onMouseLeave={() => setVolumeOpen(false)}
      >
        <IconButton
          ref={radioAnchor}
          round
          size="lg"
          icon="radio"
          label={tr(ru.radio)}
          aria-pressed={radio.enabled}
          variant={radio.enabled ? "primary" : "ghost"}
          disabled={!radio.canControl}
          onClick={toggleRadio}
        />
        <Popover
          open={volumeOpen}
          onOpenChange={setVolumeOpen}
          anchorRef={radioAnchor}
          align="end"
          autoFocus={false}
          label={tr(ru.radioVolume)}
          className="radioPopover"
        >
          {track && (
            <p className="radioTrack" aria-live="polite">
              <strong>{track.title}</strong>
              {track.artist && <span>{track.artist}</span>}
            </p>
          )}
          <div className="radioVolume">
            <Icon name="volume" />
            <Slider
              label={tr(ru.radioVolume)}
              min={0}
              max={100}
              value={radio.volume}
              onValueChange={setRadioVolume}
            />
          </div>
        </Popover>
      </div>
      {el}
      <IconButton round size="lg" variant="ghost" icon="info"
        label={tr("Инструкция")} onClick={() => navigate(routes.help)} />
    </aside>
  );
});
