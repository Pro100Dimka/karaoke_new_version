import { memo, useRef } from "react";
import { createPortal } from "react-dom";
import { Grid, IconButton, Popover, ToggleButton, tr, useLocale } from "@neo-ui-kit/react";
import { ru } from "../../../i18n/messages.ru";
import { effectPresets, type EffectPreset } from "./voiceEffects";

interface EffectPresetsProps {
  selected: string | null;
  microphoneAvailable: boolean;
  open: boolean;
  onOpenChange(open: boolean): void;
  onSelect(preset: EffectPreset): void;
}

/** Voice effect presets opened from the mixer. */
export const EffectPresets = memo(({
  selected,
  microphoneAvailable,
  open,
  onOpenChange,
  onSelect,
}: EffectPresetsProps) => {
  useLocale();
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton
        ref={anchor}
        className="consolePresetsTrigger"
        size="xs"
        round
        icon="sliders"
        label={tr(ru.consoleMode)}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      />
      {anchor.current && createPortal(<Popover
        open={open}
        onOpenChange={onOpenChange}
        anchorRef={anchor}
        align="end"
        label={tr(ru.consoleMode)}
      >
        <Grid className="consolePresets" columns={2} gap={2}>
          {effectPresets.map((preset) => (
            <ToggleButton
              key={preset.id}
              size="sm"
              checked={selected === preset.id}
              disabled={!microphoneAvailable}
              onValueChange={() => {
                onSelect(preset);
                onOpenChange(false);
              }}
            >
              {preset.symbol} {tr(ru[preset.label])}
            </ToggleButton>
          ))}
        </Grid>
      </Popover>, anchor.current.closest(".ad-theme") ?? anchor.current.ownerDocument.body)}
    </>
  );
});
