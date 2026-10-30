import { useSyncExternalStore } from "react";

let shownByDesktop = true;

export const subscribeAppVisibility = (listener: () => void): (() => void) => {
  const fromDesktop = window.desktop?.onAppVisibility?.((onScreen) => {
    shownByDesktop = onScreen;
    listener();
  });
  document.addEventListener("visibilitychange", listener);
  return () => {
    fromDesktop?.();
    document.removeEventListener("visibilitychange", listener);
  };
};

export const appVisibility = (): boolean =>
  window.desktop?.onAppVisibility ? shownByDesktop : !document.hidden;

/**
 * Whether anything of the app can be seen: the desktop reports its main window and detached panels
 * (the page itself always reads "visible" there), a plain browser uses the Page Visibility API.
 * Decoration that nobody can see stops drawing while this is false.
 */
export const useAppOnScreen = (): boolean =>
  useSyncExternalStore(subscribeAppVisibility, appVisibility, () => true);
