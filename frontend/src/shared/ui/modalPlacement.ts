/** Only changes to dialogs or their fallback theme can move modal overlays. */
export const modalPlacementChanged = (
  records: readonly MutationRecord[],
): boolean => {
  const relevant = (node: Node) =>
    node instanceof Element &&
    (node.matches('dialog, .main-theme') ||
      node.querySelector('dialog, .main-theme') !== null);
  for (const record of records) {
    if (record.type === 'attributes') {
      if (
        record.target instanceof HTMLDialogElement &&
        record.attributeName === 'open'
      )
        return true;
    } else {
      for (const node of record.addedNodes) if (relevant(node)) return true;
      for (const node of record.removedNodes) if (relevant(node)) return true;
    }
  }
  return false;
};
