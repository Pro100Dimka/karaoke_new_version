/**
 * Typefaces the user can choose for titles and for text. Melodix is the library's own musical face (its display cut
 * for titles, its text cut for reading); the others come with Windows, so they need nothing to load.
 */
export const appFonts = {
  melodix: "var(--ad-font-family-melodix)",
  melodixText: "var(--ad-font-family-melodix-text)",
  segoe: '"Segoe UI Variable", "Segoe UI", system-ui, sans-serif',
  humanist: '"Trebuchet MS", "Segoe UI", sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: "var(--ad-font-family-mono)",
} as const;

export type AppFont = keyof typeof appFonts;
export const appFontIds = Object.keys(appFonts) as AppFont[];

/** The look the app was designed with: the display cut for titles, the text cut for everything else. */
export const defaultHeadingFont: AppFont = "melodix";
export const defaultTextFont: AppFont = "melodixText";

/** Puts the chosen faces on the page root; the theme reads them (see styles.css), and panel windows mirror the root. */
export const applyAppFonts = (heading: AppFont, text: AppFont): void => {
  const root = document.documentElement.style;
  root.setProperty("--app-font-heading", appFonts[heading]);
  root.setProperty("--app-font-text", appFonts[text]);
};
