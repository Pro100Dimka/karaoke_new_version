/** True when a native file drag crossed out of the whole drop surface, not merely into one of its children. */
export const dragLeavesBoundary = (
  boundary: Node,
  relatedTarget: EventTarget | null,
): boolean => {
  const next = relatedTarget as Node | null;
  return !next || typeof next.nodeType !== "number" || !boundary.contains(next);
};
