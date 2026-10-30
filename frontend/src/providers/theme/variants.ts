import type { themes } from '@neo-ui-kit/react';
const theme = (name: string, library: keyof typeof themes) => ({
  library,
  background: new URL(`../../assets/backgrounds/${name}.webp`, import.meta.url)
    .href,
  icon: new URL(`../../assets/icons/${name}.webp`, import.meta.url).href,
  preview: {
    image: new URL(`../../assets/previews/${name}-icons.webp`, import.meta.url)
      .href,
    background: new URL(
      `../../assets/previews/${name}-backgrounds.webp`,
      import.meta.url,
    ).href,
  },
});
export const appThemes = {
  dark: theme('dark', 'ruby'),
  light: theme('light', 'light'),
  green: theme('green', 'green'),
  violet: theme('violet', 'violet'),
} as const;
