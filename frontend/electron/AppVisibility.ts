/** The parts of a window this module needs; BrowserWindow satisfies it. */
export interface WatchedWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  on(
    event: "minimize" | "restore" | "show" | "hide" | "closed",
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
) => {
  const panels = new Set<WatchedWindow>();
  const shown = (window: WatchedWindow) =>
    !window.isDestroyed() && window.isVisible() && !window.isMinimized();
  let last: boolean | undefined;
  const update = () => {
    const onScreen = shown(main) || [...panels].some(shown);
    if (onScreen === last) return;
    last = onScreen;
    publish(onScreen);
  };
  const watch = (window: WatchedWindow) => {
    for (const event of ["minimize", "restore", "show", "hide"] as const)
      window.on(event, update);
  };
  watch(main);
  return {
    addPanel(panel: WatchedWindow): void {
      panels.add(panel);
      watch(panel);
      panel.on("closed", () => {
        panels.delete(panel);
        update();
      });
      update();
    },
    /** Sends the current state again, e.g. to a renderer that has just loaded. */
    republish(): void {
      last = undefined;
      update();
    },
  };
};
