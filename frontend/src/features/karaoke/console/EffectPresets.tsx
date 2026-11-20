import { memo, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  Grid,
  IconButton,
  Popover,
  ToggleButton,
  tr,
  useLocale,
} from '@neo-ui-kit/react';
import { effectPresets, type EffectPreset } from './voiceEffects';

interface EffectPresetsProps {
  selected: string | null;
  microphoneAvailable: boolean;
  open: boolean;
  onOpenChange(open: boolean): void;
  onSelect(preset: EffectPreset): void;
}

/** Voice effect presets opened from the mixer. */
export const EffectPresets = memo(
  ({
    selected,
    microphoneAvailable,
    open,
    onOpenChange,
    onSelect,
  }: EffectPresetsProps) => {
    useLocale();
    const anchor = useRef<HTMLButtonElement>(null);
    const popupId = useId();
    // The kit dismisses popovers through the app document. A detached console owns another one.
    useEffect(() => {
      const trigger = anchor.current;
      const owner = trigger?.ownerDocument;
      if (!open || !trigger || !owner || owner === document) return;
      const popup = owner.getElementById(popupId);
      if (!popup) return;
      const key = (event: KeyboardEvent) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        onOpenChange(false);
        trigger.focus();
      };
      const outside = (event: PointerEvent) => {
        if (event.defaultPrevented) return;
        const path = event.composedPath();
        if (!path.includes(popup) && !path.includes(trigger))
          onOpenChange(false);
      };
      // Returning the still-mounted console closes its old window; its popup must close with it.
      const closed = () => onOpenChange(false);
      const ownerWindow = owner.defaultView;
      owner.addEventListener('keydown', key);
      owner.addEventListener('pointerdown', outside);
      ownerWindow?.addEventListener('pagehide', closed);
      return () => {
        owner.removeEventListener('keydown', key);
        owner.removeEventListener('pointerdown', outside);
        ownerWindow?.removeEventListener('pagehide', closed);
      };
    }, [open, onOpenChange, popupId]);
    return (
      <>
        <IconButton
          ref={anchor}
          className="consolePresetsTrigger"
          size="xs"
          round
          icon="sliders"
          label={tr('consoleMode')}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
        />
        {anchor.current &&
          createPortal(
            <Popover
              id={popupId}
              open={open}
              onOpenChange={onOpenChange}
              anchorRef={anchor}
              align="end"
              label={tr('consoleMode')}
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
                    {preset.symbol} {tr(preset.label)}
                  </ToggleButton>
                ))}
              </Grid>
            </Popover>,
            anchor.current.closest('.ad-theme') ??
              anchor.current.ownerDocument.body,
          )}
      </>
    );
  },
);
