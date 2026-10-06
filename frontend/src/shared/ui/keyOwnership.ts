/**
 * Whether a key belongs to the focused control rather than to a page's shortcuts: text typed into
 * a field, arrows of a slider or list, and Space pressing a focused button. Read by tag and role,
 * so it also works for controls in a panel moved into a window of its own.
 */
export const keyBelongsToControl = (
  target: EventTarget | null,
  key: string,
): boolean => {
  const element = target as {
    tagName?: string;
    getAttribute?(name: string): string | null;
  } | null;
  const tag = element?.tagName ?? "";
  if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return true;
  const role = element?.getAttribute?.("role");
  if (role === "slider" || role === "listbox" || role === "option") return true;
  return tag === "BUTTON" && key === " ";
};
