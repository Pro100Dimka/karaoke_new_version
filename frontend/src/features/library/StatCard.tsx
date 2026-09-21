import type { LucideIcon } from "lucide-react";
import { Sparkles } from "lucide-react";
import { Card, Typography } from "../../theme/ui";

/** A headline number of the library with its icon; sized in the kit's viewport-relative tokens. */
export const StatCard = ({ icon: Icon, value, label }: { icon: LucideIcon; value: number; label: string }) => (
  <Card variant="laser" tilt={false} className="statCard" cardContent={{ className: "statCardContent" }}>
    <span className="statCardIcon" aria-hidden>
      <Icon className="statCardGlyph" />
      <Sparkles className="statCardSpark" />
    </span>
    <div className="statCardText">
      <Typography variant="h3">{value}</Typography>
      <Typography variant="body2" tone="muted">
        {label}
      </Typography>
    </div>
  </Card>
);
