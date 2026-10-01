import { CheckCircle2, CircleDashed, CloudCog, LoaderCircle, Music2, RadioTower, ServerCog, XCircle, type LucideIcon } from "lucide-react";
import type { EnvironmentSettingDto } from "../../../../contracts/models";
import type { MessageKey } from "../../../../i18n/messages";

export type DisplayState = EnvironmentSettingDto["state"] | "checking";
export type DisplayEntry = Omit<EnvironmentSettingDto, "state"> & {
  state: DisplayState;
};
export type EnvironmentValues = Record<string, string>;
export type EnvironmentGroup = Exclude<DisplayEntry["group"], "runtime">;

export const groupOrder = [
  "kaggle",
  "recognition",
  "room",
  "deployment",
] as const satisfies readonly EnvironmentGroup[];
export const saveDelayMilliseconds = 450;
export const formatElapsed = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
const statusIcon = {
  valid: CheckCircle2,
  invalid: XCircle,
  empty: CircleDashed,
  unverified: CheckCircle2,
  checking: LoaderCircle,
} as const;
export const groupUi = {
  kaggle: {
    icon: CloudCog,
    title: "environmentGroupKaggle",
    hint: "environmentGroupKaggleHint",
  },
  recognition: {
    icon: Music2,
    title: "environmentGroupRecognition",
    hint: "environmentGroupRecognitionHint",
  },
  room: {
    icon: RadioTower,
    title: "environmentGroupRoom",
    hint: "environmentGroupRoomHint",
  },
  deployment: {
    icon: ServerCog,
    title: "environmentGroupDeployment",
    hint: "environmentGroupDeploymentHint",
  },
} as const satisfies Record<
  EnvironmentGroup,
  { icon: LucideIcon; title: MessageKey; hint: MessageKey }
>;
export const fieldUi: Readonly<
  Record<
    string,
    {
      label: MessageKey;
      md?: number;
      optional?: boolean;
      advanced?: boolean;
      hidden?: boolean;
      showWhenEmpty?: boolean;
    }
  >
> = {
  KAGGLE_API_TOKEN: { label: "environmentFieldKaggleToken", md: 12 },
  AD_VOICE_AUDD_TOKEN: {
    label: "environmentFieldAuddToken",
    md: 12,
    optional: true,
    showWhenEmpty: true,
  },
  AD_VOICE_YOUTUBE_API_KEY: {
    label: "environmentFieldYoutubeKey",
    md: 6,
    optional: true,
  },
  AD_VOICE_ROOM_SERVER_HOST: { label: "environmentFieldRoomHost", md: 12 },
  AD_VOICE_ROOM_SERVER_PORT: { label: "environmentFieldRoomApiPort", md: 6 },
  AD_VOICE_ROOM_SERVER_RELAY_PORT: { label: "environmentFieldRoomPort", md: 6 },
  AD_VOICE_ROOM_SERVER_SSH_KEY: { label: "environmentFieldRoomSshKey", md: 5 },
  AD_VOICE_ROOM_SERVER_KNOWN_HOSTS: {
    label: "environmentFieldRoomKnownHosts",
    md: 4,
  },
  AD_VOICE_ROOM_SERVER_SSH_USER: {
    label: "environmentFieldRoomSshUser",
    md: 3,
  },
};

export const valuesOf = (entries: readonly DisplayEntry[]): EnvironmentValues =>
  Object.fromEntries(entries.map((entry) => [entry.key, entry.value]));
export const effectiveState = (entry: DisplayEntry): DisplayState =>
  entry.value.trim() ? entry.state : "empty";
export const StatusMark = ({
  state,
  message,
}: {
  state: DisplayState;
  message: string;
}) => {
  const Status = statusIcon[state];
  return (
    <span className="environmentStatus" title={message} data-state={state}>
      <Status size={18} aria-label={message} />
    </span>
  );
};
