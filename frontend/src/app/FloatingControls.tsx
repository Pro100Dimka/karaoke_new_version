import { Cog, Radio, Volume2 } from "lucide-react";
import { useRef, useState, type CSSProperties } from "react";
import { useText } from "../i18n/useText";
import { IconButton, Popover, Slider, Stack } from "../theme/ui";
import { useApp } from "./AppContext";
import { useRadio } from "./RadioContext";

// Inline because IconButton sets its own --control-size; sized from the window width so it fits every screen size.
const floatingButtonStyle = { "--control-size": "clamp(3.5rem, 3.8vw, 6rem)" } as CSSProperties;

export const FloatingControls = () => {
  const { openSettings } = useApp();
  const radio = useRadio();
  const t = useText();
  const radioAnchor = useRef<HTMLElement | null>(null);
  const [volumeOpen, setVolumeOpen] = useState(false);

  return (
    <aside className="floatingControls" aria-label={t("settings")}>
      <div onMouseEnter={() => radio.enabled && setVolumeOpen(true)} onMouseLeave={() => setVolumeOpen(false)}>
        <IconButton
          ref={radioAnchor}
          icon={Radio}
          label={t("radio")}
          aria-pressed={radio.enabled}
          variant={radio.enabled ? "contained" : "outline"}
          className="floatingButton" style={floatingButtonStyle}
          disabled={!radio.canControl}
          onClick={radio.toggle}
        />
        <Popover open={volumeOpen} anchorRef={radioAnchor} placement="top-end" className="radioPopover" onClose={() => setVolumeOpen(false)}>
          <Stack direction="row" align="center" gap="0.75rem">
            <Volume2 aria-hidden className="radioPopoverIcon" />
            <Slider aria-label={t("radioVolume")} min={0} max={100} value={radio.volume} onChange={radio.setVolume} showValue={false} />
          </Stack>
        </Popover>
      </div>
      <IconButton icon={Cog} label={t("settings")} variant="outline" className="floatingButton" style={floatingButtonStyle} onClick={() => openSettings()} />
    </aside>
  );
};
