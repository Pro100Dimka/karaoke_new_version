import type { ReactNode } from "react";
import { ThemeProvider } from "@neo-ui-kit/react";
import { useApp } from "./AppContext";
import { appThemes } from "./appTheme";

/** The app's theme and its single full-window background picture. */
export const NeoTheme = ({ children }: { children: ReactNode }) => {
  const { theme: themeName } = useApp("theme");
  const theme = appThemes[themeName];
  return (
    <ThemeProvider
      className="appTheme"
      theme={theme.library}
      style={{ "--app-background": `url("${theme.background}")` }}
    >
      {children}
    </ThemeProvider>
  );
};
