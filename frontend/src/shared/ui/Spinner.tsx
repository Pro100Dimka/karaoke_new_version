import { LoaderCircle } from "lucide-react";
import { Stack, Typography } from "../../theme/ui";
import "./spinner.css";

/** Loading indicator for an operation that is really running; callers show an error state on failure. */
export const Spinner = ({ label, size = 22 }: { label?: string; size?: number }) => (
  <Stack direction="row" align="center" gap="0.5rem" role="status" aria-live="polite">
    <LoaderCircle aria-hidden className="appSpinner" size={size} />
    {label && <Typography as="span" variant="body2">{label}</Typography>}
  </Stack>
);
