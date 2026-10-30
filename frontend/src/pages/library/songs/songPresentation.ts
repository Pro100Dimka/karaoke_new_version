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
  tone: "default" | "primary" | "success" | "danger";
  primaryAction: "play" | "cancel" | "details" | "none";
  primaryLabel: MessageKey;
  primaryDisabled: boolean;
  /** Exactly the actions the state/action matrix allows; everything else is hidden or disabled. */
  actions: readonly SongActionId[];
}

export const songStatusPresentation = {
  "not-processed": {
    label: "notProcessed",
    tone: "default",
    primaryAction: "none",
    primaryLabel: "notProcessed",
    primaryDisabled: true,
    actions: ["settings", "folder", "delete"],
  },
  queued: {
    label: "queued",
    tone: "primary",
    primaryAction: "cancel",
    primaryLabel: "cancelQueueItem",
    primaryDisabled: false,
    actions: ["cancelQueued"],
  },
  processing: {
    label: "processing",
    tone: "primary",
    primaryAction: "details",
    primaryLabel: "openProcessingDetails",
    primaryDisabled: false,
    actions: ["processingDetails"],
  },
  ready: {
    label: "ready",
    tone: "success",
    primaryAction: "play",
    primaryLabel: "play",
    primaryDisabled: false,
    actions: ["play", "recordings", "settings", "folder", "delete"],
  },
  failed: {
    label: "failed",
    tone: "danger",
    primaryAction: "none",
    primaryLabel: "failed",
    primaryDisabled: true,
    actions: ["viewError", "settings", "folder", "delete"],
  },
  importing: {
    label: "importing",
    tone: "primary",
    primaryAction: "none",
    primaryLabel: "importing",
    primaryDisabled: true,
    actions: [],
  },
  invalid: {
    label: "projectInvalid",
    tone: "danger",
    primaryAction: "none",
    primaryLabel: "projectInvalid",
    primaryDisabled: true,
    actions: ["viewError", "folder", "delete"],
  },
} satisfies Record<SongStatus, SongStatusPresentation>;
