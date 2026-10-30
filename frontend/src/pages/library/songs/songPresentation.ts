import type { SongStatus } from "../../../contracts/models";
import type { MessageKey } from "../../../i18n/messages";

export type SongActionId =
  | "play"
  | "cancelQueued"
  | "processingDetails"
  | "recordings"
  | "settings"
  | "folder"
  | "viewError"
  | "delete";

interface SongStatusPresentation {
  label: MessageKey;
  tone: "offline" | "processing" | "success" | "error";
  primaryAction: SongActionId | null;
  /** Exactly the actions the state/action matrix allows; everything else is hidden or disabled. */
  actions: readonly SongActionId[];
}

export const songStatusPresentation = {
  "not-processed": {
    label: "notProcessed",
    tone: "offline",
    primaryAction: null,
    actions: ["settings", "folder", "delete"],
  },
  queued: {
    label: "queued",
    tone: "processing",
    primaryAction: "cancelQueued",
    actions: ["cancelQueued"],
  },
  processing: {
    label: "processing",
    tone: "processing",
    primaryAction: "processingDetails",
    actions: ["processingDetails"],
  },
  ready: {
    label: "ready",
    tone: "success",
    primaryAction: "play",
    actions: ["play", "recordings", "settings", "folder", "delete"],
  },
  failed: {
    label: "failed",
    tone: "error",
    primaryAction: null,
    actions: ["viewError", "settings", "folder", "delete"],
  },
  importing: {
    label: "importing",
    tone: "processing",
    primaryAction: null,
    actions: [],
  },
  invalid: {
    label: "projectInvalid",
    tone: "error",
    primaryAction: null,
    actions: ["viewError", "folder", "delete"],
  },
} satisfies Record<SongStatus, SongStatusPresentation>;
