import { useId, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { AudioArtwork } from "./AudioArtwork";

/** Neon-framed settings block with an icon, a title and a short hint aligned to the right. */
export const AudioSection = ({
  icon: Icon,
  title,
  hint,
  className = "",
  children,
}: {
  icon: LucideIcon;
  title: string;
  hint: string;
  className?: string;
  children: ReactNode;
}) => {
  const titleId = useId();
  return (
    <section className={`audioSection ${className}`.trim()} aria-labelledby={titleId}>
      <AudioArtwork kind="header" />
      <header className="audioSectionHeader">
        <span className="audioSectionTile" aria-hidden>
          <Icon className="audioSectionIcon" />
        </span>
        <h3 id={titleId}>{title}</h3>
        <span className="audioSectionHint">{hint}</span>
      </header>
      {children}
    </section>
  );
};
