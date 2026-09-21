import type { MutableRefObject, Ref, RefCallback } from "react";

export default function mergeRefs<T>(...refs: readonly (Ref<T> | undefined)[]): RefCallback<T> {
  return value => {
    for (const ref of refs) {
      if (typeof ref === "function") ref(value);
      else if (ref) (ref as MutableRefObject<T | null>).current = value;
    }
  };
}
