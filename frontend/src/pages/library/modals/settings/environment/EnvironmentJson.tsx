import { CollapsibleSection, TextArea, tr, useLocale } from "@neo-ui-kit/react";
import { ru } from "../../../../../i18n/messages.ru";
import { useEnvironmentJson } from "./useEnvironmentJson";

export const EnvironmentJson = ({
  values,
  onApply,
}: {
  values: Readonly<Record<string, string>>;
  onApply(source: string): Promise<void>;
}) => {
  useLocale();
  const { source, error, change, apply } = useEnvironmentJson(values, onApply);

  return (
    <CollapsibleSection
      className="environmentJson"
      icon="braces"
      title={tr(ru.environmentJson)}
      description={tr(ru.environmentJsonHint)}
    >
      <TextArea
        className="environmentJsonEditor"
        aria-label={tr(ru.environmentJson)}
        rows={10}
        spellCheck={false}
        value={source}
        onValueChange={change}
        onBlur={() => void apply()}
        error={error}
      />
    </CollapsibleSection>
  );
};
