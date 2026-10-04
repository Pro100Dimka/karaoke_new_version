import { useEffect, useState } from "react";
import { CollapsibleSection, TextArea } from "@ad-voice/ui";
import { useText } from "../../../../i18n/useText";

/** Validates the editor text; the message is shown under the editor. */
const problemOf = (source: string): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(source);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? undefined : "JSON must contain an object";
  } catch {
    return "Invalid JSON";
  }
};

/** All ENV values as one editable JSON object behind a disclosure; leaving the editor applies it. */
export const EnvironmentJson = ({ values, onApply }: {
  values: Readonly<Record<string, string>>;
  onApply(source: string): Promise<void>;
}) => {
  const t = useText();
  const formatted = JSON.stringify(values, null, 2);
  const [source, setSource] = useState(formatted);
  const [error, setError] = useState<string>();
  useEffect(() => setSource(formatted), [formatted]);

  const apply = () => {
    const problem = problemOf(source);
    setError(problem);
    if (!problem) void onApply(source).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  };

  return (
    <CollapsibleSection className="environmentJson" icon="braces" title={t("environmentJson")} description={t("environmentJsonHint")}>
      <TextArea className="environmentJsonEditor" aria-label={t("environmentJson")} rows={10} spellCheck={false}
        value={source} onValueChange={setSource} onBlur={apply} error={error} />
    </CollapsibleSection>
  );
};
