import type { SongStatus } from "../../contracts/models";
import type { MessageKey } from "../../i18n/messages";

export type SongActionId =
  | "play"
  | "process"
  | "reprocess"
  | "cancelQueued"
  | "processingDetails"
  | "recordings"
  | "settings"
  | "folder"
  | "viewError"
  | "delete";

interface SongStatusPresentation {
  label: MessageKey;
  tone: "default" | "primary" | "success" | "danger";
  primaryAction: "play" | "process" | "cancel" | "details" | "repair" | "none";
  primaryLabel: MessageKey;
  primaryDisabled: boolean;
  /** Exactly the actions the state/action matrix allows; everything else is hidden or disabled. */
  actions: readonly SongActionId[];
}

export const songStatusPresentation = {
  "not-processed": {
    label: "notProcessed",
    tone: "default",
    primaryAction: "process",
    primaryLabel: "process",
    primaryDisabled: false,
    actions: ["process", "settings", "folder", "delete"]
  },
  queued: {
    label: "queued",
    tone: "primary",
    primaryAction: "cancel",
    primaryLabel: "cancelQueueItem",
    primaryDisabled: false,
    actions: ["cancelQueued"]
  },
  processing: {
    label: "processing",
    tone: "primary",
    primaryAction: "details",
    primaryLabel: "openProcessingDetails",
    primaryDisabled: false,
    actions: ["processingDetails"]
  },
  ready: {
    label: "ready",
    tone: "success",
    primaryAction: "play",
    primaryLabel: "play",
    primaryDisabled: false,
    actions: ["play", "recordings", "settings", "folder", "reprocess", "delete"]
  },
  failed: {
    label: "failed",
    tone: "danger",
    primaryAction: "process",
    primaryLabel: "retryReprocess",
    primaryDisabled: false,
    actions: ["reprocess", "viewError", "settings", "folder", "delete"]
  },
  importing: {
    label: "importing",
    tone: "primary",
    primaryAction: "none",
    primaryLabel: "importing",
    primaryDisabled: true,
    actions: []
  },
  invalid: {
    label: "projectInvalid",
    tone: "danger",
    primaryAction: "repair",
    primaryLabel: "repairReprocess",
    primaryDisabled: false,
    actions: ["viewError", "reprocess", "folder", "delete"]
  }
} satisfies Record<SongStatus, SongStatusPresentation>;

export const songCanPlay = (status: SongStatus): boolean =>
  (songStatusPresentation[status].actions as readonly SongActionId[]).includes("play");
