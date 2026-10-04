/** Checks an IPC argument that must be a string; the renderer is never trusted to send one. */
export const requireString = (value: unknown, name: string): string => {
  if (typeof value !== "string")
    throw new TypeError(`${name} must be a string`);
  return value;
};

/** Checks an IPC argument that must be a number. */
export const requireNumber = (value: unknown, name: string): number => {
  if (typeof value !== "number")
    throw new TypeError(`${name} must be a number`);
  return value;
};

/** Checks an IPC argument that must be an object and exposes its fields for further checks. */
export const requireObject = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== "object")
    throw new TypeError(`${name} must be an object`);
  return value as Record<string, unknown>;
};
