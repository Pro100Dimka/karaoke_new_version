export const supportedAudioExtensions = [
  "mp3",
  "wav",
  "flac",
  "m4a",
  "ogg",
] as const;

export const isSupportedAudio = (extension: string): boolean =>
  (supportedAudioExtensions as readonly string[]).includes(
    extension.toLowerCase(),
  );
