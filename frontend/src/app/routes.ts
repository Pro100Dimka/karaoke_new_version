const routeSegments = {
  karaoke: "karaoke",
  editor: "editor"
} as const;

export const routePatterns = {
  library: "/",
  karaoke: `/${routeSegments.karaoke}/:songId`,
  editor: `/${routeSegments.editor}/:songId`
} as const;

export const routes = {
  library: routePatterns.library,
  karaoke: (songId: string) => `/${routeSegments.karaoke}/${encodeURIComponent(songId)}`,
  editor: (songId: string) => `/${routeSegments.editor}/${encodeURIComponent(songId)}`
} as const;
