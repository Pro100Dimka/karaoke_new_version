import { useApp } from "./AppContext";
import { useCloseGuard } from "./CloseGuards";
import { useAsk } from "./DialogProvider";
import { useText } from "../i18n/useText";
import { audioClient } from "../services/audioClient";
import { pythonClient } from "../services/pythonClient";

const activeStates = new Set(["queued", "processing", "cancelling"]);
const cancelWaitMilliseconds = 500;
const cancelWaitAttempts = 120;

const sleep = (milliseconds: number) => new Promise(resolve => window.setTimeout(resolve, milliseconds));

/** Application-level close policy: processing, room and audio session are settled before the window closes. */
export const AppCloseFlow = () => {
  const { room, setRoom } = useApp();
  const ask = useAsk();
  const t = useText();

  useCloseGuard(async () => {
    const jobs = await pythonClient.listJobs().catch(() => []);
    const active = jobs.filter(job => activeStates.has(job.state));
    if (active.length > 0) {
      const choice = await ask({
        title: t("closeWithProcessingTitle"),
        body: t("closeWithProcessingBody", { count: active.length }),
        actions: [
          { id: "keep", label: t("keepOpen") },
          { id: "exit", label: t("cancelJobsAndExit"), appearance: "primary" }
        ]
      });
      if (choice !== "exit") return false;
      await Promise.all(active.map(job => pythonClient.cancelJob(job.id).catch(() => undefined)));
      // Running stages finish safely first; shutdown waits for the backend to confirm.
      for (let attempt = 0; attempt < cancelWaitAttempts; attempt += 1) {
        const remaining = (await pythonClient.listJobs().catch(() => [])).filter(job => activeStates.has(job.state));
        if (remaining.length === 0) break;
        await sleep(cancelWaitMilliseconds);
      }
    }
    if (room) {
      await pythonClient.leaveRoom(room.code).catch(() => undefined);
      setRoom(null);
    }
    await audioClient.stop().catch(() => undefined);
    return true;
  });

  return null;
};
