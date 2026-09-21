import { useState } from "react";

/** Works controlled (value given) or uncontrolled (internal state); onChange fires either way. */
export default function useControllable<T, E = unknown>(
  value: T | undefined,
  defaultValue: T,
  onChange?: (value: T, event?: E) => void
): [T, (next: T | ((current: T) => T), event?: E) => T] {
  const controlled = value !== undefined;
  const [internal, setInternal] = useState<T>(defaultValue);
  const current = controlled ? value : internal;

  const set = (next: T | ((current: T) => T), event?: E): T => {
    const resolved = typeof next === "function" ? (next as (current: T) => T)(current) : next;
    if (!controlled) setInternal(resolved);
    onChange?.(resolved, event);
    return resolved;
  };

  return [current, set];
}
