import type { EnvironmentSettingDto } from "../../../../../contracts/models";

export type DisplayState = EnvironmentSettingDto["state"] | "checking";
export type DisplayEntry = Omit<EnvironmentSettingDto, "state"> & {
  state: DisplayState;
  errorMessage?: string | null;
};
export type EnvironmentGroup = Exclude<DisplayEntry["group"], "runtime">;

export const saveDelayMilliseconds = 450;
/** Secrets are write-only: the backend never returns them, so a saved one shows as `configured` with no value. */
export const isSecret = (entry: DisplayEntry): boolean =>
  entry.kind === "secret";
export const hasValue = (entry: DisplayEntry): boolean =>
  Boolean(entry.value.trim()) || (isSecret(entry) && entry.configured);

/** The technical JSON holds every value the user can read back; secrets stay out of it. */
export const valuesOf = (
  entries: readonly DisplayEntry[],
): Record<string, string> =>
  Object.fromEntries(
    entries.flatMap((entry) =>
      isSecret(entry) ? [] : [[entry.key, entry.value]],
    ),
  );
export const effectiveState = (entry: DisplayEntry): DisplayState =>
  entry.state === "invalid" || entry.state === "checking" || hasValue(entry)
    ? entry.state
    : "empty";

/** A group reports its most urgent field state, otherwise whether anything is set at all. */
const urgentStates: readonly DisplayState[] = [
  "invalid",
  "checking",
  "unverified",
];
export const groupState = (entries: readonly DisplayEntry[]): DisplayState => {
  const states = entries.map(effectiveState);
  return (
    urgentStates.find((state) => states.includes(state)) ??
    (entries.some(hasValue) ? "valid" : "empty")
  );
};
