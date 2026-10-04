import type { EnvironmentSettingDto } from "../../../../contracts/models";
import type { MessageKey } from "../../../../i18n/messages";

export type DisplayState = EnvironmentSettingDto["state"] | "checking";
export type DisplayEntry = Omit<EnvironmentSettingDto, "state"> & {
  state: DisplayState;
};
export type EnvironmentGroup = Exclude<DisplayEntry["group"], "runtime">;

export const saveDelayMilliseconds = 450;
export const formatElapsed = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

export const groupUi = {
  kaggle: { icon: "cloud-gpu", title: "environmentGroupKaggle", hint: "environmentGroupKaggleHint" },
  recognition: { icon: "music", title: "environmentGroupRecognition", hint: "environmentGroupRecognitionHint" },
  room: { icon: "antenna", title: "environmentGroupRoom", hint: "environmentGroupRoomHint" },
  deployment: { icon: "upload", title: "environmentGroupDeployment", hint: "environmentGroupDeploymentHint" },
} as const satisfies Record<EnvironmentGroup, { icon: string; title: MessageKey; hint: MessageKey }>;

/** Friendly label and share of the 12-column row for each known key. */
export const fieldUi: Readonly<Record<string, { label: MessageKey; span: 3 | 4 | 5 | 6 | 12; optional?: boolean; showWhenEmpty?: boolean }>> = {
  KAGGLE_API_TOKEN: { label: "environmentFieldKaggleToken", span: 12 },
  AD_VOICE_AUDD_TOKEN: { label: "environmentFieldAuddToken", span: 12, optional: true, showWhenEmpty: true },
  AD_VOICE_YOUTUBE_API_KEY: { label: "environmentFieldYoutubeKey", span: 6, optional: true },
  AD_VOICE_ROOM_SERVER_HOST: { label: "environmentFieldRoomHost", span: 12 },
  AD_VOICE_ROOM_SERVER_PORT: { label: "environmentFieldRoomApiPort", span: 6 },
  AD_VOICE_ROOM_SERVER_RELAY_PORT: { label: "environmentFieldRoomPort", span: 6 },
  AD_VOICE_ROOM_SERVER_SSH_KEY: { label: "environmentFieldRoomSshKey", span: 5 },
  AD_VOICE_ROOM_SERVER_KNOWN_HOSTS: { label: "environmentFieldRoomKnownHosts", span: 4 },
  AD_VOICE_ROOM_SERVER_SSH_USER: { label: "environmentFieldRoomSshUser", span: 3 },
};

/** Secrets are write-only: the backend never returns them, so a saved one shows as `configured` with no value. */
export const isSecret = (entry: DisplayEntry): boolean => entry.kind === "secret";
const hasValue = (entry: DisplayEntry): boolean =>
  Boolean(entry.value.trim()) || (isSecret(entry) && entry.configured);

/** The technical JSON holds every value the user can read back; secrets stay out of it. */
export const valuesOf = (entries: readonly DisplayEntry[]): Record<string, string> =>
  Object.fromEntries(entries.filter(entry => !isSecret(entry)).map(entry => [entry.key, entry.value]));
export const effectiveState = (entry: DisplayEntry): DisplayState =>
  hasValue(entry) ? entry.state : "empty";

const stateMessage: Partial<Record<DisplayState, MessageKey>> = {
  valid: "environmentReady",
  checking: "checking",
  unverified: "environmentSaved",
};
/** What a field says about its value; only an invalid one shows the backend's own message. */
export const messageKeyFor = (entry: DisplayEntry): MessageKey | null => {
  const state = effectiveState(entry);
  if (state === "empty") return fieldUi[entry.key]?.optional ? "environmentOptional" : "environmentNotConfigured";
  return stateMessage[state] ?? null;
};

/** A group reports its most urgent field state, otherwise whether anything is set at all. */
const urgentStates: readonly DisplayState[] = ["invalid", "checking", "unverified"];
export const groupState = (entries: readonly DisplayEntry[]): DisplayState => {
  const states = entries.map(effectiveState);
  return urgentStates.find(state => states.includes(state))
    ?? (entries.some(hasValue) ? "valid" : "empty");
};

/** Entries shown in a group: recognition services appear only once used, except the ones offered up front. */
export const groupEntries = (entries: readonly DisplayEntry[], group: EnvironmentGroup) =>
  entries.filter(entry => entry.group === group
    && (group !== "recognition" || hasValue(entry) || fieldUi[entry.key]?.showWhenEmpty));
