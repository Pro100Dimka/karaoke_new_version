import { useRef, useState } from "react";
import { Icon, IconButton, Popover, Slider } from "@ad-voice/ui";
import { useText } from "../i18n/useText";
import { useApp } from "./AppContext";
import { useRadio } from "./RadioContext";

/** The radio and settings buttons in the lower corner; the radio's volume opens on hover. */
export const FloatingControls = () => {
  const { openSettings } = useApp();
  const radio = useRadio();
  const t = useText();
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
      <IconButton
        round
        size="lg"
        className="floatingButton"
        icon="settings"
        label={t("settings")}
        onClick={() => openSettings()}
      />
    </aside>
  );
};
