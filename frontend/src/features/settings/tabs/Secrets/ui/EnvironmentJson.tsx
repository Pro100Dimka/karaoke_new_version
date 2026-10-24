import { CollapsibleSection, TextArea } from "@neo-ui-kit/react";
import { useText } from "../../../../../i18n/useText";
import { useEnvironmentJson } from "../hooks/useEnvironmentJson";

export const EnvironmentJson = ({
  values,
  onApply,
}: {
  values: Readonly<Record<string, string>>;
  onApply(source: string): Promise<void>;
}) => {
  const t = useText();
  const { source, error, change, apply } = useEnvironmentJson(values, onApply);

  return (
    <CollapsibleSection
      className="environmentJson"
      icon="braces"
      title={t("environmentJson")}
      description={t("environmentJsonHint")}
    >
      <TextArea
        className="environmentJsonEditor"
        aria-label={t("environmentJson")}
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
