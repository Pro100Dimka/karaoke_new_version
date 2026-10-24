import { Card, type FormFieldDefinition, FormFields } from "@neo-ui-kit/react";
import type { ReactNode } from "react";

interface IFormCardProps {
  title: string;
  description?: string;
  icon?: string;
  fields?: FormFieldDefinition<Record<string, unknown>>[];
  children?: ReactNode;
  style?: React.CSSProperties;
}
const FormCard = (props: IFormCardProps) => {
  const { title, description, icon, fields, children, style } = props;
  return (
    <Card
      title={title}
      description={description || ""}
      border
      icon={icon || ""}
      style={{ height: "100%", background: "transparent", ...style }}
    >
      {fields && <FormFields fields={fields} />}
      {children}
    </Card>
  );
};
export default FormCard;
