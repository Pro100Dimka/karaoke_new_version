import { useSyncExternalStore } from "react";

let shownByDesktop = true;

const subscribe = (listener: () => void): (() => void) => {
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

const snapshot = (): boolean => shownByDesktop && !document.hidden;

/**
 * Whether anything of the app can be seen: the desktop reports its main window and detached panels
 * (the page itself always reads "visible" there), a plain browser uses the Page Visibility API.
 * Decoration that nobody can see stops drawing while this is false.
 */
export const useAppOnScreen = (): boolean =>
  useSyncExternalStore(subscribe, snapshot, () => true);
