import type { AppError } from "../contracts/models";

/** The preload API: the only way the renderer reaches Electron Main and, through it, every service. */
export const desktopBridge = (): DesktopApi => {
  if (!window.desktop) throw new Error("Desktop bridge is unavailable");
  return window.desktop;
};

/** Sends an HTTP request through the bridge and rethrows a failed response as the server's own AppError. */
export const bridgedHttp = async <T>(
  target: "pythonRequest" | "roomRequest",
  request: PythonBridgeRequest,
  fallbackMessage: string,
): Promise<T> => {
  const response = await desktopBridge()[target](request);
  if (response.ok) return response.body as T;
  const raw =
    response.body && typeof response.body === "object"
      ? (response.body as Record<string, unknown>)
      : {};
  throw {
    code: typeof raw.code === "string" ? raw.code : `Http${response.status}`,
    message: typeof raw.message === "string" ? raw.message : fallbackMessage,
    details:
      raw.details === undefined ? undefined : JSON.stringify(raw.details),
    source: "python",
    correlationId:
      typeof raw.requestId === "string" ? raw.requestId : undefined,
  } satisfies AppError;
};
