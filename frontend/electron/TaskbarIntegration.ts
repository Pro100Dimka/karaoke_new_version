import type { BrowserWindow, NativeImage } from "electron";
import type { BackendEvent } from "./BackendEvents";
import type { DesktopShell, ShellCommand, ShellStatus } from "./DesktopShell";
import { overlayColors, shellIcon, type iconShapes } from "./ShellIcons";
import { shellText, type ShellTextKey } from "./ShellText";

const activeStates = new Set(["Queued", "Running", "Cancelling"]);

export type JobOutcome = "succeeded" | "failed";

/**
 * Processing jobs as the backend reports them (`job.changed`): how far the active ones are, and
 * which just finished. The taskbar shows the progress from any screen, not only the Library.
 */
export class JobProgress {
  private readonly active = new Map<string, number>();

  /** Returns the outcome when this event finished a job that was being followed. */
  track(event: BackendEvent): JobOutcome | undefined {
    if (event.type === "connected") {
      // Events missed while the stream was down: progress is rebuilt from the next ones.
      this.active.clear();
      return undefined;
    }
    if (event.type !== "job.changed" || !event.data) return undefined;
    const { jobId, state, overallProgress } = event.data;
    if (typeof jobId !== "string" || typeof state !== "string") return undefined;
    if (activeStates.has(state)) {
      const progress = typeof overallProgress === "number" && Number.isFinite(overallProgress) ? overallProgress : 0;
      this.active.set(jobId, Math.max(0, Math.min(1, progress)));
      return undefined;
    }
    const followed = this.active.delete(jobId);
    if (!followed) return undefined;
    if (state === "Succeeded") return "succeeded";
    if (state === "Failed") return "failed";
    return undefined;
  }

  /** -1 hides the bar; "indeterminate" while every job only waits. */
  bar(): { progress: number; mode: "none" | "normal" | "indeterminate" } {
    if (this.active.size === 0) return { progress: -1, mode: "none" };
    const values = [...this.active.values()];
    const progress = values.reduce((sum, value) => sum + value, 0) / values.length;
    return progress > 0 ? { progress, mode: "normal" } : { progress: 2, mode: "indeterminate" };
  }
}

export interface ThumbButton {
  icon: keyof typeof iconShapes;
  tooltip: ShellTextKey;
  command: ShellCommand;
}

/** The buttons under the taskbar thumbnail for what is on screen. */
export const thumbButtons = (status: ShellStatus): ThumbButton[] => {
  if (status.screen === "karaoke" && status.song)
    return [
      status.playing
        ? { icon: "pause", tooltip: "pause", command: { type: "togglePlayback" } }
        : { icon: "play", tooltip: "play", command: { type: "togglePlayback" } },
    ];
  if (status.screen === "library" && status.radio.available)
    return [
      { icon: "radio", tooltip: status.radio.enabled ? "radioOff" : "radioOn", command: { type: "toggleRadio" } },
      { icon: "next", tooltip: "nextStation", command: { type: "nextStation" } },
    ];
  return [];
};

/** The badge on the taskbar icon: recording first, then being in a room. */
export const overlayFor = (status: ShellStatus): { icon: keyof typeof iconShapes; color: keyof typeof overlayColors; text: ShellTextKey } | null => {
  if (status.recording) return { icon: "dot", color: "recording", text: "recording" };
  if (status.room) return { icon: "people", color: "room", text: "inRoom" };
  return null;
};

interface TaskbarOptions {
  window: () => BrowserWindow | null;
  shell: DesktopShell;
  notify: (title: string, body: string) => void;
  icon?: (name: keyof typeof iconShapes, color?: readonly [number, number, number]) => NativeImage;
}

/** Keeps the taskbar entry in step with the app: progress, badge, thumbnail buttons, attention. */
export const createTaskbarIntegration = ({ window, shell, notify, icon = shellIcon }: TaskbarOptions) => {
  const jobs = new JobProgress();
  let lastButtons = "";
  let lastOverlay = "";

  const applyProgress = () => {
    const current = window();
    if (!current || current.isDestroyed()) return;
    const { progress, mode } = jobs.bar();
    current.setProgressBar(progress, mode === "none" ? undefined : { mode });
  };

  const applyStatus = (status: ShellStatus) => {
    const current = window();
    if (!current || current.isDestroyed()) return;
    const overlay = overlayFor(status);
    const overlayKey = overlay ? `${overlay.icon}:${status.language}` : "";
    if (overlayKey !== lastOverlay) {
      lastOverlay = overlayKey;
      current.setOverlayIcon(
        overlay ? icon(overlay.icon, overlayColors[overlay.color]) : null,
        overlay ? shellText(status.language, overlay.text) : "",
      );
    }
    const buttons = thumbButtons(status);
    const buttonsKey = JSON.stringify([buttons, status.language]);
    // Windows keeps a thumbnail toolbar's slots once created; an unchanged set is not sent again.
    if (buttonsKey !== lastButtons && current.isVisible()) {
      lastButtons = buttonsKey;
      current.setThumbarButtons(
        buttons.map((button) => ({
          icon: icon(button.icon),
          tooltip: shellText(status.language, button.tooltip),
          click: () => shell.send(button.command),
        })),
      );
    }
  };

  shell.onStatus((status) => applyStatus(status));

  return {
    /** Every backend event goes through here (see streamBackendEvents in main.ts). */
    backendEvent(event: BackendEvent): void {
      const outcome = jobs.track(event);
      applyProgress();
      const current = window();
      if (!outcome || !current || current.isDestroyed() || current.isFocused()) return;
      const language = shell.status().language;
      current.flashFrame(true);
      if (outcome === "succeeded") notify(shellText(language, "songReady"), shellText(language, "songReadyBody"));
      else notify(shellText(language, "songFailed"), shellText(language, "songFailedBody"));
    },
    /** The window was shown: Windows only accepts thumbnail buttons on a visible window. */
    refresh(): void {
      lastButtons = "";
      lastOverlay = "";
      applyStatus(shell.status());
      applyProgress();
    },
  };
};
