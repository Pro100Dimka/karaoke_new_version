import type { MessageKey } from "../../../../../i18n/messages";
import {
  effectiveState,
  hasValue,
  type DisplayEntry,
  type DisplayState,
  type EnvironmentGroup,
} from "./environmentModel";

export const formatElapsed = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

export const groupUi = {
  kaggle: {
    icon: "cloud-gpu",
    title: "environmentGroupKaggle",
    hint: "environmentGroupKaggleHint",
  },
  recognition: {
    icon: "music",
    title: "environmentGroupRecognition",
    hint: "environmentGroupRecognitionHint",
  },
  room: {
    icon: "antenna",
    title: "environmentGroupRoom",
    hint: "environmentGroupRoomHint",
  },
  deployment: {
    icon: "upload",
    title: "environmentGroupDeployment",
    hint: "environmentGroupDeploymentHint",
  },
} as const satisfies Record<
  EnvironmentGroup,
  { icon: string; title: MessageKey; hint: MessageKey }
>;

/** Friendly label and share of the 12-column row for each known key. */
export const fieldUi: Readonly<
  Record<
    string,
    {
      label: MessageKey;
      span: 3 | 4 | 5 | 6 | 12;
      optional?: boolean;
      showWhenEmpty?: boolean;
    }
  >
> = {
  KAGGLE_API_TOKEN: { label: "environmentFieldKaggleToken", span: 12 },
  AD_VOICE_AUDD_TOKEN: {
    label: "environmentFieldAuddToken",
    span: 12,
    optional: true,
    showWhenEmpty: true,
  },
  AD_VOICE_YOUTUBE_API_KEY: {
    label: "environmentFieldYoutubeKey",
    span: 6,
    optional: true,
  },
  AD_VOICE_ROOM_SERVER_HOST: { label: "environmentFieldRoomHost", span: 12 },
  AD_VOICE_ROOM_SERVER_PORT: { label: "environmentFieldRoomApiPort", span: 6 },
  AD_VOICE_ROOM_SERVER_RELAY_PORT: {
    label: "environmentFieldRoomPort",
    span: 6,
  },
  AD_VOICE_ROOM_SERVER_SSH_KEY: {
    label: "environmentFieldRoomSshKey",
    span: 5,
  },
  AD_VOICE_ROOM_SERVER_KNOWN_HOSTS: {
    label: "environmentFieldRoomKnownHosts",
    span: 4,
  },
  AD_VOICE_ROOM_SERVER_SSH_USER: {
    label: "environmentFieldRoomSshUser",
    span: 3,
  },
};

const stateMessage: Partial<Record<DisplayState, MessageKey>> = {
  valid: "environmentReady",
  checking: "checking",
  unverified: "environmentSaved",
};
/** Why a value is invalid, in the interface language (the backend's own text is English). */
const invalidMessage = (entry: DisplayEntry): MessageKey => {
  if (
    entry.key === "AD_VOICE_AUDD_TOKEN" ||
    entry.key === "AD_VOICE_YOUTUBE_API_KEY"
  )
    return "environmentRejectedKey";
  if (entry.key.startsWith("AD_VOICE_ROOM_SERVER") && entry.kind !== "file")
    return entry.kind === "port"
      ? "environmentInvalidValue"
      : "environmentRoomServerUnavailable";
  if (entry.kind === "url") return "environmentInvalidUrl";
  if (entry.kind === "file") return "environmentInvalidFile";
  return "environmentInvalidValue";
};

/** What a field says about its value. */
export const messageKeyFor = (entry: DisplayEntry): MessageKey | null => {
  const state = effectiveState(entry);
  if (state === "empty")
    return fieldUi[entry.key]?.optional
      ? "environmentOptional"
      : "environmentNotConfigured";
  if (state === "invalid") return invalidMessage(entry);
  return stateMessage[state] ?? null;
};

/** Entries shown in a group: recognition services appear only once used, except the ones offered up front. */
export const groupEntries = (
  entries: readonly DisplayEntry[],
  group: EnvironmentGroup,
) =>
  entries.filter(
    (entry) =>
      entry.group === group &&
      (group !== "recognition" ||
        hasValue(entry) ||
        fieldUi[entry.key]?.showWhenEmpty),
  );
