import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import cx from "../../theme/ui/_internal/cx";
import { NeonFrame } from "../../shared/ui/NeonFrame";

export const SettingsCard = ({
  icon: Icon,
  title,
  description,
  className,
  frameOrder = 0,
  children
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  className?: string;
  frameOrder?: number;
  children?: ReactNode;
}) => (
  <article className={cx("settingCard", className)}>
    <NeonFrame order={frameOrder} />
    <div className="settingCardHeader">
      <span className="settingCardTile" aria-hidden="true"><Icon /></span>
      <div className="settingCardHeading">
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
    </div>
    <div className="settingCardContent">{children}</div>
  </article>
);
