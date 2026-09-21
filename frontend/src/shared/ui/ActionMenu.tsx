import { useRef, useState, type ReactNode } from "react";
import { Button, Popover, Stack } from "../../theme/ui";
import "./action-menu.css";

export interface ActionMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  run(): void;
}

interface ActionMenuProps {
  trigger(props: { ref: React.RefObject<HTMLElement | null>; "aria-haspopup": "menu"; "aria-expanded": boolean; onClick(): void }): ReactNode;
  items: readonly ActionMenuItem[];
}

/** A small menu built from the kit's Popover and Button; the caller supplies the trigger element. */
export const ActionMenu = ({ trigger, items }: ActionMenuProps) => {
  const anchor = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);

  return (
    <>
      {trigger({ ref: anchor, "aria-haspopup": "menu", "aria-expanded": open, onClick: () => setOpen(value => !value) })}
      <Popover open={open} anchorRef={anchor} onClose={() => setOpen(false)} placement="bottom-end" role="menu" className="appActionMenu">
        <Stack gap="0.25rem">
          {items.map(item => (
            <Button
              key={item.id}
              role="menuitem"
              variant="outlined"
              tone={item.destructive ? "danger" : "neutral"}
              size="sm"
              startIcon={item.icon}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.run();
              }}
            >
              {item.label}
            </Button>
          ))}
        </Stack>
      </Popover>
    </>
  );
};
