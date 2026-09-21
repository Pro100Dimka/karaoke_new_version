import { AlertTriangle, CircleAlert, CircleCheck, Info, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Card, Stack, Typography } from "../../theme/ui";
import "./alert.css";

export type AlertIntent = "info" | "success" | "warning" | "error";

const icons = { info: Info, success: CircleCheck, warning: AlertTriangle, error: CircleAlert } as const satisfies Record<AlertIntent, LucideIcon>;

interface AlertProps {
  intent?: AlertIntent;
  children: ReactNode;
  actions?: ReactNode;
  role?: "alert" | "status";
}

/** Inline, non-blocking notice; errors are announced as alerts and everything else as status. */
export const Alert = ({ intent = "info", children, actions, role }: AlertProps) => {
  const Icon = icons[intent];
  return (
    <Card as="div" className="appAlert" data-intent={intent} role={role ?? (intent === "error" ? "alert" : "status")} tilt={false}>
      <Icon aria-hidden size={18} />
      <Typography as="span" variant="body2" className="appAlertText">
        {children}
      </Typography>
      {actions && <Stack direction="row" gap="0.5rem" className="appAlertActions">{actions}</Stack>}
    </Card>
  );
};
