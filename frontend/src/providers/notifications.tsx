import { Toast, tr } from '@neo-ui-kit/react';
import {
  createContext,
  use,
  useCallback,
  useLayoutEffect,
  useState,
  type PropsWithChildren,
} from 'react';
import { createPortal } from 'react-dom';
import { getErrorMessage } from 'react-error-boundary';
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


interface Notification { message: string; tone: NotificationIntent; id: number }

const Context = createContext<Notify>(console.error);
export const useNotify = () => use(Context);
export const useErrorHandler = () => {
  const notify = useNotify();
  return useCallback(
    (error: unknown) =>
      notify(
        getErrorMessage(error)?.trim() || tr('errorHandler.unknown'),
        'error',
      ),
    [notify],
  );
};

export const NotificationsProvider = ({ children }: PropsWithChildren) => {
  const [container] = useState(() => document.createElement('div'));
  const [toast, setToast] = useState<Notification>();
  const notify = useCallback(
    (message: string, tone: NotificationIntent = 'success', options?: { silent?: boolean }) => {
      if (!options?.silent) playNotificationSound(tone);
      setToast((previous) => ({ message, tone, id: (previous?.id ?? 0) + 1 }));
    },
    [],
  );
  const visible = !!toast;
  useLayoutEffect(() => {
    if (!visible) return;
    const place = () => {
      const target =
        [...document.querySelectorAll('dialog:modal')].at(-1) ??
        document.querySelector('.main-theme') ??
        document.body;
      if (container.parentElement !== target) target.append(container);
    };
    place();
    const observer = new MutationObserver(place);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['open'],
    });
    return () => {
      observer.disconnect();
      container.remove();
    };
  }, [container, visible]);
  return (
    <Context value={notify}>
      {children}
      {toast &&
        createPortal(
          <Toast
            key={toast.id}
            floating
            tone={toast.tone}
            message={toast.message}
            onClose={() => setToast(undefined)}
          />,
          container,
        )}
    </Context>
  );
};

export default NotificationsProvider;
