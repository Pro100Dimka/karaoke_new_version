/** Checks an IPC argument that must be a string; the renderer is never trusted to send one. */
export const requireString = (value: unknown, name: string): string => {
  if (typeof value !== "string")
    throw new TypeError(`${name} must be a string`);
  return value;
};
