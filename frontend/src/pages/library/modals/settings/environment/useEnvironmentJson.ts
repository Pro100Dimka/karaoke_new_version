import { useRef, useState } from "react";

/** A dirty JSON draft belongs to the editor until its own save succeeds. */
export const useEnvironmentJson = (
  values: Readonly<Record<string, string>>,
  onApply: (source: string) => Promise<void>,
) => {
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const source = draft ?? JSON.stringify(values, null, 2);

  const change = (value: string) => {
    generation.current++;
    setDraft(value);
    setError(undefined);
  };
  const apply = async () => {
    const current = ++generation.current;
    setError(undefined);
    try {
      await onApply(source);
      if (generation.current === current) {
        setError(undefined);
        setDraft(undefined);
      }
    } catch (reason) {
      if (generation.current === current)
        setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return { source, error, change, apply };
};
