import { useLayoutEffect, useState } from 'react';

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

export const useTopModal = () => {
  const [modal, setModal] = useState<HTMLDialogElement | null>(null);
  useLayoutEffect(() => {
    if (typeof HTMLDialogElement.prototype.showModal !== 'function') return;
    let stack: HTMLDialogElement[] = [];
    const update = (records: MutationRecord[] = []) => {
      if (records.length && !modalPlacementChanged(records)) return;
      // Attribute records preserve opening order even when it differs from DOM order.
      for (const { target, attributeName } of records) {
        if (!(target instanceof HTMLDialogElement) || attributeName !== 'open')
          continue;
        stack = stack.filter((dialog) => dialog !== target);
        if (target.matches(':modal')) stack.push(target);
      }
      stack = stack.filter(
        (dialog) => dialog.isConnected && dialog.matches(':modal'),
      );
      for (const dialog of document.querySelectorAll<HTMLDialogElement>(
        'dialog:modal',
      ))
        if (!stack.includes(dialog)) stack.push(dialog);
      setModal(stack.at(-1) ?? null);
    };
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['open'],
    });
    update();
    return () => observer.disconnect();
  }, []);
  return modal;
};
