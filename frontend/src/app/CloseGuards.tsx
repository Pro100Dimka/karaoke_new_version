import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { desktopClient } from "../services/desktopClient";

/** Returns true when closing may continue; may ask the user and finalize work first. */
export type CloseGuard = () => Promise<boolean>;

type RegisterGuard = (guard: CloseGuard) => () => void;

const GuardContext = createContext<RegisterGuard | null>(null);

export const CloseGuardsProvider = ({ children }: { children: ReactNode }) => {
  const guards = useRef(new Set<CloseGuard>());
  const running = useRef(false);

  const register = useCallback<RegisterGuard>(guard => {
    guards.current.add(guard);
    return () => guards.current.delete(guard);
  }, []);

  useEffect(
    () =>
      desktopClient.onCloseRequested(() => {
        if (running.current) return;
        running.current = true;
        void (async () => {
          try {
            for (const guard of [...guards.current]) {
              if (!(await guard())) return;
            }
            await desktopClient.confirmClose();
          } finally {
            running.current = false;
          }
        })();
      }),
    []
  );

  const value = useMemo(() => register, [register]);
  return <GuardContext.Provider value={value}>{children}</GuardContext.Provider>;
};

/** Registers the latest guard for the lifetime of the calling component. */
export const useCloseGuard = (guard: CloseGuard): void => {
  const register = useContext(GuardContext);
  if (!register) throw new Error("useCloseGuard must be used inside CloseGuardsProvider");
  const latest = useRef(guard);
  latest.current = guard;
  useEffect(() => register(() => latest.current()), [register]);
};
