/** A single portable directory/file component, including Windows device-name restrictions. */
export const isSafePathComponent = (value: string): boolean =>
  value.length > 0 && value.length <= 255 &&
  !/[<>:"/\\|?*\u0000-\u001f]/.test(value) && !/[. ]$/.test(value) &&
  !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(value);
