import { useId } from "react";

/** Stable control/hint/error ids plus the aria-describedby value shared by all form controls. */
export default function useFieldIds(prefix: string, id: string | undefined, hint?: string, error?: string) {
  const uid = useId().replace(/:/g, "");
  const controlId = id || `${prefix}-${uid}`;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;
  return { controlId, hintId, errorId, describedBy };
}
