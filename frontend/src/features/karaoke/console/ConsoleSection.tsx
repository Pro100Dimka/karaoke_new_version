import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/** A titled glass panel of the lower console row: song channels, effects, parameters or mode. */
export const ConsoleSection = ({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) => (
  <section className="consoleSection" aria-label={title}>
    <header className="consoleSectionHeader">
      <Icon aria-hidden />
      <span>{title}</span>
    </header>
    {children}
  </section>
);
