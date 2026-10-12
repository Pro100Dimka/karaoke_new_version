import { Card } from "@neo-ui-kit/react";
import type { ReactNode } from "react";

/** A titled glass panel of the lower console row: song channels, effects, parameters or mode. */
export const ConsoleSection = ({
  title,
  children,
}: {
  icon: string;
  title: string;
  children: ReactNode;
}) => (
  <Card
    material="glass"
    padding="sm"
    level={4}
    className="consoleSection"
    aria-label={title}
  >
    {children}
  </Card>
);
