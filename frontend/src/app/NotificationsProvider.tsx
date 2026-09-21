import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Alert, type AlertIntent } from "../shared/ui/Alert";

export type NotificationIntent = AlertIntent;
type Notify = (message: string, intent?: NotificationIntent) => void;

const NotifyContext = createContext<Notify | null>(null);
const visibleMilliseconds = 4000;
const maxVisible = 4;

interface Toast {
  id: number;
  message: string;
  intent: NotificationIntent;
}

export const NotificationsProvider = ({ children }: { children: ReactNode }) => {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const nextId = useRef(0);

  const notify = useCallback<Notify>((message, intent = "info") => {
    const id = (nextId.current += 1);
    setToasts(current => [...current.slice(-(maxVisible - 1)), { id, message, intent }]);
    window.setTimeout(() => setToasts(current => current.filter(toast => toast.id !== id)), visibleMilliseconds);
  }, []);
  const value = useMemo(() => notify, [notify]);

  return (
    <NotifyContext.Provider value={value}>
      {children}
      <div className="toastLayer" aria-live="polite">
        {toasts.map(toast => (
          <Alert key={toast.id} intent={toast.intent}>
            {toast.message}
          </Alert>
        ))}
      </div>
    </NotifyContext.Provider>
  );
};

export const useNotify = (): Notify => {
  const value = useContext(NotifyContext);
  if (!value) throw new Error("useNotify must be used inside NotificationsProvider");
  return value;
};
