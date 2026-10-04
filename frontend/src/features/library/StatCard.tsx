import { Card, Icon, Typography } from "@ad-voice/ui";

/** A headline number of the library with its glowing icon. */
export const StatCard = ({ icon, value, label }: { icon: string; value: number; label: string }) => (
  <Card border padding="sm" className="statCard">
    <span className="statCardIcon" aria-hidden="true"><Icon name={icon} /><Icon name="sparkle" className="statCardSpark" /></span>
    <span className="statCardText">
      <Typography as="strong" variant="h2">{value}</Typography>
      <Typography variant="body-sm" tone="muted">{label}</Typography>
    </span>
  </Card>
);
