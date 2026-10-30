import { ToggleButton, tr, useLocale } from "@neo-ui-kit/react";
import type { MessageKey } from "../../../i18n/messages";
import { ru } from "../../../i18n/messages.ru";
import { useKaraokeTv } from "../tv/karaokeTv";

interface DisplayTogglesProps {
  showNotes: boolean;
  showLyrics: boolean;
  autoHide: boolean;
  hasNotes: boolean;
  hasLyrics: boolean;
  onShowNotes(value: boolean): void;
  onShowLyrics(value: boolean): void;
  onAutoHide(value: boolean): void;
}

/**
 * Independent switches for the piano roll, the lyrics and console auto-hide, and, while a second
 * screen is connected, for moving the whole Karaoke onto it (a TV) and back.
 */
export const DisplayToggles = ({
  showNotes,
  showLyrics,
  autoHide,
  hasNotes,
  hasLyrics,
  onShowNotes,
  onShowLyrics,
  onAutoHide,
}: DisplayTogglesProps) => {
  useLocale();
  const tv = useKaraokeTv();
  const toggles: readonly {
    id: string;
    label: MessageKey;
    icon: string;
    active: boolean;
    disabled: boolean;
    set(value: boolean): void;
  }[] = [
    {
      id: "notes",
      label: "toolNotes",
      icon: "wave",
      active: showNotes,
      disabled: !hasNotes,
      set: onShowNotes,
    },
    {
      id: "lyrics",
      label: "toolText",
      icon: "document",
      active: showLyrics,
      disabled: !hasLyrics,
      set: onShowLyrics,
    },
    {
      id: "autohide",
      label: "toolAutoHide",
      icon: "cursor",
      active: autoHide,
      disabled: false,
      set: onAutoHide,
    },
    ...(tv && (tv.available || tv.active)
      ? [
          {
            id: "tv",
            label: "tvSend" as const,
            icon: "window",
            active: tv.active,
            disabled: false,
            set: (value: boolean) => (value ? tv.send() : tv.bringBack()),
          },
        ]
      : []),
  ];
  return (
    <div className="displayToggles" role="group" aria-label={tr(ru.stageLayers)}>
      {toggles.map((toggle) => (
        <ToggleButton
          key={toggle.id}
          data-toggle={toggle.id}
          size="sm"
          icon={toggle.icon}
          checked={toggle.active}
          disabled={toggle.disabled}
          style={{ flex: 1 }}
          onValueChange={toggle.set}
        >
          {tr(ru[toggle.label])}
        </ToggleButton>
      ))}
    </div>
  );
};
