/**
 * The document and window an element lives in. A panel moved into a window of its own renders
 * there, so its popovers, tooltips and lists must open, position and listen in that window too.
 */
export const ownerDocumentOf = (node?: Node | null): Document => node?.ownerDocument ?? document;

export const ownerWindowOf = (node?: Node | null): Window =>
  node?.ownerDocument?.defaultView ?? window;
