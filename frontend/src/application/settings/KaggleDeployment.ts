import type { PythonClient } from "../../contracts/clients";
import type { KaggleActionDto } from "../../contracts/models";

type Deployment = { promise: Promise<KaggleActionDto>; startedAt: number };
let active: Deployment | null = null;

/** A settings dialog reopened mid-deployment observes the same job. */
export const kaggleDeployment = (backend: Pick<PythonClient, "deployKaggle">): Deployment => {
  if (active) return active;
  const deployment = { promise: backend.deployKaggle(), startedAt: Date.now() };
  active = deployment;
  void deployment.promise.finally(() => {
    if (active === deployment) active = null;
  }).catch(() => undefined);
  return deployment;
};

export const kaggleDeploymentRunning = (): boolean => active !== null;
