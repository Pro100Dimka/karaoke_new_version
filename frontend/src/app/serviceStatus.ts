export const expectedPythonApiVersion = 1;

export type ServiceStatus =
  | { kind: "starting" }
  | { kind: "ready"; version: string }
  | { kind: "unavailable" }
  | { kind: "incompatible"; version: string; expected: string };

export const isReady = (status: ServiceStatus): boolean => status.kind === "ready";

export const pythonStatusFrom = (result: {
  status: "ready" | "unavailable";
  version: string;
  apiVersion: number;
}): ServiceStatus => {
  if (result.apiVersion !== expectedPythonApiVersion) {
    return { kind: "incompatible", version: `API ${result.apiVersion}`, expected: `API ${expectedPythonApiVersion}` };
  }
  return result.status === "ready" ? { kind: "ready", version: result.version } : { kind: "unavailable" };
};

/** A service that came back after being down invalidates every snapshot the renderer holds for it. */
export const reconnected = (previous: ServiceStatus, next: ServiceStatus): boolean =>
  previous.kind !== "starting" && !isReady(previous) && isReady(next);

/** Services need seconds to boot; until one has been ready once, "unavailable" within this window means "starting". */
export const startupGraceMilliseconds = 60_000;

export const withStartupGrace = (next: ServiceStatus, everReady: boolean, elapsedMilliseconds: number): ServiceStatus =>
  next.kind === "unavailable" && !everReady && elapsedMilliseconds < startupGraceMilliseconds ? { kind: "starting" } : next;
