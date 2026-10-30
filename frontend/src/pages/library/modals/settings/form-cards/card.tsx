import { Card, FormFields, useFormContext } from '@neo-ui-kit/react';
import { observer } from 'mobx-react-lite';
import type {
  FormCardProps,
  SettingsFormValues,
} from '../../../../../utils/contracts';

const FormCard = observer(
  ({ fields, children, style, ...props }: FormCardProps) => {
    const form = useFormContext<SettingsFormValues>();
    const visibleFields = fields
      ?.filter((field) => field.showWhen?.(form.values) ?? true)
      .map((field) => {
        form.field(field.name);
        return { ...field };
      });
    return (
      <Card
        {...props}
        border
        style={{ height: '100%', background: 'transparent', ...style }}
      >
        {visibleFields && <FormFields fields={visibleFields} />}
        {children}
      </Card>
    );
  },
);

export default FormCard;
