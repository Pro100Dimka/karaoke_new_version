const routeSegments = {
  karaoke: "karaoke",
  editor: "editor",
} as const;

export const routePatterns = {
  library: "/",
  help: "/help",
  karaoke: `/${routeSegments.karaoke}/:songId`,
  editor: `/${routeSegments.editor}/:songId`,
} as const;

export const routes = {
  library: routePatterns.library,
  help: routePatterns.help,
  karaoke: (songId: string) =>
    `/${routeSegments.karaoke}/${encodeURIComponent(songId)}`,
  editor: (songId: string) =>
    `/${routeSegments.editor}/${encodeURIComponent(songId)}`,
} as const;
