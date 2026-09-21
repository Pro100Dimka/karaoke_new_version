export const supportedAudioExtensions = ["mp3", "wav", "flac", "m4a", "ogg"] as const;

export const isSupportedAudio = (extension: string): boolean =>
  (supportedAudioExtensions as readonly string[]).includes(extension.toLowerCase());

/** Filename-derived fallback used until the backend reads embedded tags: "Artist - Title.ext". */
export const guessMetadata = (fileName: string): { artist: string; title: string } => {
  const stem = fileName.replace(/\.[^.]+$/, "");
  const separator = stem.indexOf(" - ");
  if (separator > 0) return { artist: stem.slice(0, separator).trim(), title: stem.slice(separator + 3).trim() };
  return { artist: "", title: stem.trim() };
};
