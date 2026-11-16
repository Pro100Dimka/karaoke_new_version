/** The parts of a window this module needs; BrowserWindow satisfies it. */
interface WatchedWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  isFocused(): boolean;
  on(
    event:
      'minimize' | 'restore' | 'show' | 'hide' | 'focus' | 'blur' | 'closed',
    listener: () => void,
  ): unknown;
}

/**
 * Whether any part of the app is on screen: the main window or a panel moved into its own window.
 * The main window keeps background throttling off so detached panels keep drawing, which also keeps
 * its Page Visibility API at "visible" even while minimized; this replaces that signal for the app.
 */
export const watchAppVisibility = (
  main: WatchedWindow,
  publish: (onScreen: boolean) => void,
  publishFocus?: (focused: boolean) => void,
) => {
  const panels = new Set<WatchedWindow>();
  const shown = (window: WatchedWindow) =>
    !window.isDestroyed() && window.isVisible() && !window.isMinimized();
  let last: boolean | undefined;
  let lastFocused: boolean | undefined;
  let focusTimer: ReturnType<typeof setTimeout> | undefined;
  const appFocused = () =>
    [main, ...panels].some((window) => shown(window) && window.isFocused());
  const updateFocus = () => {
    if (!publishFocus) return;
    clearTimeout(focusTimer);
    const send = () => {
      const focused = appFocused();
      if (focused === lastFocused) return;
      lastFocused = focused;
      publishFocus(focused);
    };
    if (appFocused()) send();
    // Native blur may precede focus of another app-owned window.
    else focusTimer = setTimeout(send, 50);
  };
  const update = () => {
    const onScreen = shown(main) || [...panels].some(shown);
    if (onScreen !== last) {
      last = onScreen;
      publish(onScreen);
    }
    updateFocus();
  };
  const watch = (window: WatchedWindow) => {
    for (const event of [
      'minimize',
      'restore',
      'show',
      'hide',
      'focus',
      'blur',
    ] as const)
      window.on(event, update);
  };
  watch(main);
  main.on('closed', () => clearTimeout(focusTimer));
  return {
    addPanel(panel: WatchedWindow): void {
      panels.add(panel);
      watch(panel);
      panel.on('closed', () => {
        panels.delete(panel);
        update();
      });
      update();
    },
    /** Sends the current state again, e.g. to a renderer that has just loaded. */
    republish(): void {
      last = undefined;
      lastFocused = undefined;
      update();
    },
  };
};
