import type { ReactNode } from "react";
import { Card } from "@ad-voice/ui";

/** A titled glass panel of the lower console row: song channels, effects, parameters or mode. */
export const ConsoleSection = ({ icon, title, children }: { icon: string; title: string; children: ReactNode }) => (
  <Card material="glass" padding="sm" level={4} icon={icon} title={title} className="consoleSection" aria-label={title}>
    {children}
  </Card>
);
