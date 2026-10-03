import { useSyncExternalStore } from "react";

const root = () => document.documentElement;

const subscribe = (onChange: () => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(root(), { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
};

/**
 * The app theme's two main colours, read from its palette (theme/palettes.css stays the only
 * source), so the Neo UI surfaces of the settings follow whichever theme is on screen.
 */
export const useAppPalette = () => {
  const theme = useSyncExternalStore(subscribe, () => root().dataset.theme ?? "");
  const style = getComputedStyle(root());
  const read = (token: string) => style.getPropertyValue(token).trim() || undefined;
  return { theme, primary: read("--color-primary"), secondary: read("--color-primary-hover") };
};
