import { useEffect, useRef } from "react";
import { desktopClient } from "../services/desktopClient";

/** Returns true when closing may continue; may ask the user and finalize work first. */
export type CloseGuard = () => Promise<boolean>;
const guards = new Set<CloseGuard>();

export const subscribeCloseRequests = () => {
  let running = false;
  return desktopClient.onCloseRequested(() => {
    if (running) return;
    running = true;
    void (async () => {
      let allowed = false;
      try {
        for (const guard of [...guards]) {
          if (!(await guard())) return;
        }
        allowed = true;
      } catch (error) {
        console.error("Cannot finish work before closing", error);
      } finally {
        running = false;
        await desktopClient.confirmClose(allowed);
      }
    })().catch((error) => console.error("Cannot report close decision", error));
  });
};

/** Registers the latest guard for the lifetime of the calling component. */
export const useCloseGuard = (guard: CloseGuard): void => {
  const latest = useRef(guard);
  latest.current = guard;
  useEffect(() => {
    const registered = () => latest.current();
    guards.add(registered);
    return () => { guards.delete(registered); };
  }, []);
};
