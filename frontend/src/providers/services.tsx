import { runInAction } from 'mobx';
import { store } from './store';
import { audioClient } from '../services/audioClient';
import { pythonClient } from '../services/pythonClient';
import {
  isReady,
  pythonStatusFrom,
  reconnected,
  sameServiceStatus,
  withStartupGrace,
  type ServiceStatus,
} from '../app/serviceStatus';

export const subscribeServices = () => {
  const launchedAt = Date.now();
  let active = true;
  let probing = false;
  const seenReady = { python: false, audio: false };
  let timer: ReturnType<typeof setTimeout>;
  const publish = (service: keyof typeof seenReady, status: ServiceStatus) => {
    if (!active) return;
    if (!seenReady[service])
      performance.mark(`startup:${service}:${status.kind}`);
    const next = withStartupGrace(
      status,
      seenReady[service],
      Date.now() - launchedAt,
    );
    seenReady[service] ||= isReady(next);
    runInAction(() => {
      const services = store.application.services;
      if (reconnected(services[service], next)) services[`${service}Epoch`]++;
      if (!sameServiceStatus(services[service], next)) services[service] = next;
    });
  };
  const probe = async () => {
    if (!active || probing) return;
    probing = true;
    try {
      await Promise.all([
        pythonClient
          .health()
          .then(pythonStatusFrom)
          .catch((): ServiceStatus => ({ kind: 'unavailable' }))
          .then((status) => publish('python', status)),
        audioClient
          .health()
          .then((result): ServiceStatus =>
            result.status === 'ready'
              ? {
                  kind: 'ready',
                  version: result.version,
                  instanceId: result.instanceId,
                }
              : { kind: 'unavailable' },
          )
          .catch((): ServiceStatus => ({ kind: 'unavailable' }))
          .then((status) => publish('audio', status)),
      ]);
    } finally {
      probing = false;
    }
  };
  runInAction(() => {
    store.application.services = {
      python: { kind: 'starting' },
      audio: { kind: 'starting' },
      pythonEpoch: 0,
      audioEpoch: 0,
      probe,
    };
  });
  const poll = async () => {
    await probe();
    if (active)
      timer = setTimeout(
        poll,
        isReady(store.application.services.python) &&
          isReady(store.application.services.audio)
          ? 4000
          : 1000,
      );
  };
  void poll();
  return () => {
    active = false;
    clearTimeout(timer);
  };
};
