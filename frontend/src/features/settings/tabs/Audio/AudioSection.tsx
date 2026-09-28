import { useId, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/** Neon-framed settings block with an icon, a title and a short hint aligned to the right. */
export const AudioSection = ({
  icon: Icon,
  title,
  hint,
  children,
}: {
  icon: LucideIcon;
  title: string;
  hint: string;
  children: ReactNode;
}) => {
  const titleId = useId();
  return (
    <section className="audioSection" aria-labelledby={titleId}>
      <header className="audioSectionHeader">
        <Icon className="audioSectionIcon" aria-hidden />
        <h3 id={titleId}>{title}</h3>
        <span className="audioSectionHint">{hint}</span>
      </header>
      {children}
    </section>
  );
};
