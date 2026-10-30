import { observer } from "mobx-react-lite";
import { store } from "../providers/store";
import { tr, useLocale } from "@neo-ui-kit/react";
import { roomSession } from "../providers/application";
import { useCloseGuard } from "../providers/close-guards";
import { ask } from "../providers/dialog";
import { ru } from "../i18n/messages.ru";
import { audioClient } from "../services/audioClient";
import { pythonClient } from "../services/pythonClient";

const activeStates = new Set(["queued", "processing", "cancelling"]);
const cancelWaitMilliseconds = 500;
const cancelWaitAttempts = 120;

const sleep = (milliseconds: number) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

/** Application-level close policy: processing, room and audio session are settled before the window closes. */
export const AppCloseFlow = observer(() => {
  const { room } = store.online;
  useLocale();

  useCloseGuard(async () => {
    const jobs = await pythonClient.listJobs().catch(() => []);
    const active = jobs.filter((job) => activeStates.has(job.state));
    if (active.length > 0) {
      const choice = await ask({
        title: tr(ru.closeWithProcessingTitle),
        body: tr(ru.closeWithProcessingBody, { count: active.length }),
        actions: [
          { id: "keep", label: tr(ru.keepOpen) },
          { id: "exit", label: tr(ru.cancelJobsAndExit), appearance: "primary" },
        ],
      });
      if (choice !== "exit") return false;
      await Promise.all(
        active.map((job) =>
          pythonClient.cancelJob(job.id).catch(() => undefined),
        ),
      );
      // Running stages finish safely first; shutdown waits for the backend to confirm.
      for (let attempt = 0; attempt < cancelWaitAttempts; attempt += 1) {
        const remaining = (
          await pythonClient.listJobs().catch(() => [])
        ).filter((job) => activeStates.has(job.state));
        if (remaining.length === 0) break;
        await sleep(cancelWaitMilliseconds);
      }
    }
    if (room) {
      await roomSession.leave().catch(() => undefined);
    }
    await audioClient.stop().catch(() => undefined);
    return true;
  });

  return null;
});
