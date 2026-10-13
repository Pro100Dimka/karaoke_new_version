import { createContext, useContext } from "react";

/**
 * The window a screen of the app is shown in: the app's own, or one it renders into (Karaoke on a
 * TV). Keys, pointer moves and the viewport size are read from this window, not the app's.
 */
export const HostWindowContext = createContext<Window>(window);

export const useHostWindow = (): Window => useContext(HostWindowContext);
