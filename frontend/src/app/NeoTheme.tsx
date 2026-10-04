import { useSyncExternalStore, type ReactNode } from "react";
import { ThemeProvider } from "@ad-voice/ui";

const root = () => document.documentElement;

const subscribe = (onChange: () => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(root(), { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
};

/**
 * The app theme's two main colours, read from its palette (theme/palettes.css stays the only
 * source), so every Neo UI surface follows whichever theme is on screen.
 */
const useAppPalette = () => {
  const theme = useSyncExternalStore(subscribe, () => root().dataset.theme ?? "");
  const style = getComputedStyle(root());
  const read = (token: string) => style.getPropertyValue(token).trim() || undefined;
  return { theme, primary: read("--color-primary"), secondary: read("--color-primary-hover") };
};

/** Neo UI theme for the whole app; its wrapper takes no part in layout. */
export const NeoTheme = ({ children }: { children: ReactNode }) => {
  const palette = useAppPalette();
  return (
    <ThemeProvider className="appTheme" primary={palette.primary} secondary={palette.secondary}>
      {children}
    </ThemeProvider>
  );
};
