import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export const SettingsCard = ({
  icon: Icon,
  title,
  description,
  children
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  children?: ReactNode;
}) => (
  <article className="settingCard">
    <Icon aria-hidden />
    <div className="settingCardContent">
      <strong>{title}</strong>
      <span>{description}</span>
    </div>
    {children}
  </article>
);
