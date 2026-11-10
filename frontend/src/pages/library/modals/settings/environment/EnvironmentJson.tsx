import { CollapsibleSection, TextArea, tr, useLocale } from '@neo-ui-kit/react';
import { useEnvironmentJson } from './useEnvironmentJson';

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
      title={tr('environmentJson')}
      description={tr('environmentJsonHint')}
    >
      <TextArea
        className="environmentJsonEditor"
        aria-label={tr('environmentJson')}
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
