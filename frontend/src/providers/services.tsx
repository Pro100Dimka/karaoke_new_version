import { runInAction } from "mobx";
import { store } from "./store";
import { audioClient } from "../services/audioClient";
import { pythonClient } from "../services/pythonClient";
import { isReady, pythonStatusFrom, reconnected, sameServiceStatus, withStartupGrace, type ServiceStatus } from "../app/serviceStatus";

export const subscribeServices = () => {
  const launchedAt = Date.now();
  let active = true;
  let probing = false;
  let pythonSeenReady = false;
  let audioSeenReady = false;
  let timer: ReturnType<typeof setTimeout>;
  const probe = async () => {
    if (!active || probing) return;
    probing = true;
    try {
      const [python, audio] = await Promise.all([
        pythonClient.health().then(pythonStatusFrom).catch((): ServiceStatus => ({ kind: "unavailable" })),
        audioClient.health().then((result): ServiceStatus => result.status === "ready"
          ? { kind: "ready", version: result.version, instanceId: result.instanceId }
          : { kind: "unavailable" }).catch((): ServiceStatus => ({ kind: "unavailable" })),
      ]);
      if (!active) return;
      const elapsed = Date.now() - launchedAt;
      const nextPython = withStartupGrace(python, pythonSeenReady, elapsed);
      const nextAudio = withStartupGrace(audio, audioSeenReady, elapsed);
      pythonSeenReady ||= isReady(nextPython);
      audioSeenReady ||= isReady(nextAudio);
      runInAction(() => {
        const services = store.application.services;
        if (reconnected(services.python, nextPython)) services.pythonEpoch++;
        if (reconnected(services.audio, nextAudio)) services.audioEpoch++;
        if (!sameServiceStatus(services.python, nextPython)) services.python = nextPython;
        if (!sameServiceStatus(services.audio, nextAudio)) services.audio = nextAudio;
      });
    } finally {
      probing = false;
    }
  };
  runInAction(() => {
    store.application.services = { python: { kind: "starting" }, audio: { kind: "starting" }, pythonEpoch: 0, audioEpoch: 0, probe };
  });
  const poll = async () => {
    await probe();
    if (active) timer = setTimeout(poll, isReady(store.application.services.python) && isReady(store.application.services.audio) ? 4000 : 1000);
  };
  void poll();
  return () => { active = false; clearTimeout(timer); };
};
