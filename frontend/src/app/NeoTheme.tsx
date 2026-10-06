import type { ReactNode } from "react";
import { ThemeProvider } from "@ad-voice/ui";
import { useApp } from "./AppContext";
import { appThemes } from "./appTheme";

/** Neo UI theme for the whole app: every colour, font and surface comes from it; its wrapper takes no part in layout. */
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
