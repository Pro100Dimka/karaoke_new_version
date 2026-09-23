import { useRef, useState, type ReactNode } from "react";
import { Button, IconButton, Popover, Stack } from "../../theme/ui";
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
  trigger(props: {
    ref: React.RefObject<HTMLElement | null>;
    "aria-haspopup": "menu";
    "aria-expanded": boolean;
    onClick(): void;
  }): ReactNode;
  items: readonly ActionMenuItem[];
  iconOnly?: boolean;
}

/** A small menu built from the kit's Popover and Button; the caller supplies the trigger element. */
export const ActionMenu = ({
  trigger,
  items,
  iconOnly = false,
}: ActionMenuProps) => {
  const anchor = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);

  return (
    <>
      {trigger({
        ref: anchor,
        "aria-haspopup": "menu",
        "aria-expanded": open,
        onClick: () => setOpen((value) => !value),
      })}
      <Popover
        open={open}
        anchorRef={anchor}
        onClose={() => setOpen(false)}
        placement="bottom-end"
        variant="simple"
        cardContent={{ style: { padding: "0", boxShadow: "unset" } }}
        role="menu"
      >
        <Stack gap="0.25rem">
          {items.map((item) =>
            iconOnly ? (
              <IconButton
                key={item.id}
                role="menuitem"
                variant="contained"
                tone={item.destructive ? "danger" : "neutral"}
                size="md"
                label={item.label}
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.run();
                }}
              >
                {item.icon}
              </IconButton>
            ) : (
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
            ),
          )}
        </Stack>
      </Popover>
    </>
  );
};
