import { useEffect, useState, type RefObject } from 'react';

interface NearViewObserver {
  observer: IntersectionObserver;
  targets: Map<Element, Set<() => void>>;
  releaseIfEmpty(): void;
}

const observers = new WeakMap<Document, Map<string, NearViewObserver>>();

/** One observer can watch the whole archive, with separate pools for each document/margin. */
const observeNearView = (
  element: Element,
  margin: string,
  onNear: () => void,
): (() => void) => {
  let margins = observers.get(element.ownerDocument);
  if (!margins) {
    margins = new Map();
    observers.set(element.ownerDocument, margins);
  }
  let shared = margins.get(margin);
  if (!shared) {
    const targets = new Map<Element, Set<() => void>>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const listeners = targets.get(entry.target);
          if (!listeners) continue;
          targets.delete(entry.target);
          observer.unobserve(entry.target);
          for (const listener of listeners) listener();
        }
        shared!.releaseIfEmpty();
      },
      { rootMargin: margin },
    );
    const group: NearViewObserver = {
      observer,
      targets,
      releaseIfEmpty() {
        if (targets.size || margins.get(margin) !== group) return;
        observer.disconnect();
        margins.delete(margin);
      },
    };
    shared = group;
    margins.set(margin, group);
  }
  let listeners = shared.targets.get(element);
  if (!listeners) {
    listeners = new Set();
    shared.targets.set(element, listeners);
    shared.observer.observe(element);
  }
  listeners.add(onNear);
  return () => {
    const current = shared.targets.get(element);
    if (current?.delete(onNear) && current.size === 0) {
      shared.targets.delete(element);
      shared.observer.unobserve(element);
    }
    shared.releaseIfEmpty();
  };
};

/**
 * Whether an element has come near the visible part of its scroll area (within `margin`); it stays
 * true from then on. Heavy parts of long lists (waveforms with their animations) mount only then.
 * Without IntersectionObserver everything counts as in view.
 */
export const useNearView = (
  ref: RefObject<Element | null>,
  margin = '200px',
): boolean => {
  const [near, setNear] = useState(
    () => typeof IntersectionObserver === 'undefined',
  );
  useEffect(() => {
    const element = ref.current;
    if (near || !element) return;
    return observeNearView(element, margin, () => setNear(true));
  }, [ref, margin, near]);
  return near;
};
