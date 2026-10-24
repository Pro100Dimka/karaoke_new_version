import { Icon, IconButton, Popover, Slider } from "@neo-ui-kit/react";
import { useRef, useState } from "react";
// import SettingsModal from "../features/settingsNEW";
import { useText } from "../i18n/useText";
import { useApp } from "./AppContext";
import { useRadio } from "./RadioContext";
import { useRadioTrack } from "./desktop/shellBus";

/** The radio and settings buttons in the lower corner; the radio's volume opens on hover. */
export const FloatingControls = () => {
  const t = useText();
  const radio = useRadio();
  const track = useRadioTrack();
  const { openSettings } = useApp("actions");
  const el = (
    <IconButton
      round
      size="lg"
      className="floatingButton"
      icon="settings"
      label={t("settings")}
      onClick={() => openSettings()}
    />
  );
  const radioAnchor = useRef<HTMLButtonElement>(null);
  const [volumeOpen, setVolumeOpen] = useState(false);

  return (
    <aside className="floatingControls" aria-label={t("settings")}>
      <div
        onMouseEnter={() => radio.enabled && setVolumeOpen(true)}
        onMouseLeave={() => setVolumeOpen(false)}
      >
        <IconButton
          ref={radioAnchor}
          round
          size="lg"
          className="floatingButton"
          icon="radio"
          label={t("radio")}
          aria-pressed={radio.enabled}
          variant={radio.enabled ? "primary" : "secondary"}
          disabled={!radio.canControl}
          onClick={radio.toggle}
        />
        <Popover
          open={volumeOpen}
          onOpenChange={setVolumeOpen}
          anchorRef={radioAnchor}
          align="end"
          autoFocus={false}
          label={t("radioVolume")}
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
              label={t("radioVolume")}
              min={0}
              max={100}
              value={radio.volume}
              onValueChange={radio.setVolume}
            />
          </div>
        </Popover>
      </div>
      {el}
      {/* <SettingsModal /> */}
    </aside>
  );
};
