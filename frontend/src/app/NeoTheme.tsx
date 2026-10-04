import type { ReactNode } from "react";
import { ThemeProvider } from "@ad-voice/ui";
import { useApp } from "./AppContext";
import { appThemes } from "./appTheme";

/** Neo UI theme for the whole app: every colour, font and surface comes from it; its wrapper takes no part in layout. */
export const NeoTheme = ({ children }: { children: ReactNode }) => {
  const { preferences } = useApp();
  const theme = appThemes[preferences.theme];
  return (
    <ThemeProvider className="appTheme" theme={theme.library} style={{ "--app-background": `url("${theme.background}")` }}>
      {children}
    </ThemeProvider>
  );
};
