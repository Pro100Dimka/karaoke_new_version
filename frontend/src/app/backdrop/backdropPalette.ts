const fields = ["primary", "primaryHover", "secondary", "accent", "highlight"] as const;

export type BackdropPalette = Record<(typeof fields)[number], string>;

const cssName = (prefix: string, key: string): string =>
  `--${prefix}-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`;

export const backdropPalette = (styles: CSSStyleDeclaration): BackdropPalette =>
  Object.fromEntries(
    fields.map(key => {
      const vivid = styles.getPropertyValue(cssName("visualizer", key)).trim();
      const fallback = styles.getPropertyValue(cssName("color", key)).trim();
      return [key, vivid || fallback];
    }),
  ) as BackdropPalette;
