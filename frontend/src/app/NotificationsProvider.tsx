import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { MessageBar } from "@neo-ui-kit/react";
import infoUrl from "../assets/sounds/notice-info.ogg";
import successUrl from "../assets/sounds/notice-success.ogg";
import warningUrl from "../assets/sounds/notice-warning.ogg";
import errorUrl from "../assets/sounds/notice-error.ogg";
import invitationUrl from "../assets/sounds/notice-invitation.ogg";

export type NotificationIntent = "info" | "success" | "warning" | "error";
type Notify = (message: string, intent?: NotificationIntent, options?: { silent?: boolean }) => void;

const soundUrls = { info: infoUrl, success: successUrl, warning: warningUrl, error: errorUrl, invitation: invitationUrl };
let sounding: HTMLAudioElement | undefined;

/** Short, bounded interface sounds; a new notice replaces the tail instead of building a noisy queue. */
export const playNotificationSound = (kind: keyof typeof soundUrls): void => {
  sounding?.pause();
  sounding = new Audio(soundUrls[kind]);
  sounding.volume = 0.45;
  void sounding.play().catch(() => undefined);
};

const NotifyContext = createContext<Notify | null>(null);
const visibleMilliseconds = 4000;
const maxVisible = 4;

interface Toast {
  id: number;
  message: string;
  intent: NotificationIntent;
}

/** Short notices stacked in a corner of every screen; each leaves by itself after a few seconds. */
export const NotificationsProvider = ({
  children,
}: {
  children: ReactNode;
}) => {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const nextId = useRef(0);

  const notify = useCallback<Notify>((message, intent = "info", options) => {
    if (!options?.silent) playNotificationSound(intent);
    const id = (nextId.current += 1);
    setToasts((current) => [
      ...current.slice(-(maxVisible - 1)),
      { id, message, intent },
    ]);
    window.setTimeout(
      () => setToasts((current) => current.filter((toast) => toast.id !== id)),
      visibleMilliseconds,
    );
  }, []);
  const value = useMemo(() => notify, [notify]);

  return (
    <NotifyContext.Provider value={value}>
      {children}
      <div className="toastLayer" aria-live="polite">
        {toasts.map((toast) => (
          <MessageBar key={toast.id} tone={toast.intent}>
            {toast.message}
          </MessageBar>
        ))}
      </div>
    </NotifyContext.Provider>
  );
};

export const useNotify = (): Notify => {
  const value = useContext(NotifyContext);
  if (!value)
    throw new Error("useNotify must be used inside NotificationsProvider");
  return value;
};
