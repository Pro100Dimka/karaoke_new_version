import { setIn } from "formik";
import type { ReactNode } from "react";
import Button from "../Button";
import Typography from "../Typography";
import TextField from "../TextField";
import { controls, textTypes, type ControlComponent } from "./fieldKinds";
import type { FormRow, FormState } from "./types";
import useFieldBinding, { type FieldCommit } from "./useFieldBinding";

export type PickFolder = (current?: string) => Promise<string | null | undefined>;

interface FieldProps {
  row: FormRow;
  formik: FormState | undefined;
  components: Readonly<Record<string, ControlComponent>>;
  onFieldCommit?: FieldCommit;
  pickFolder?: PickFolder;
}

/** Renders one row: a registered custom component, a text/label/button primitive, or a kit control. */
export const Field = ({ row, formik, components, onFieldCommit, pickFolder }: FieldProps): ReactNode => {
  const field = useFieldBinding(row, formik, onFieldCommit);
  const { name, kind, type, state, value, message, props, bound, current, change, blur, persist, parseValue, errorText } = field;
  const Custom = components[type];

  if (Custom || field.render) {
    const customProps = { ...bound, tag: name, formik: state, children: field.children };
    return Custom ? <Custom {...customProps} /> : field.render?.(customProps);
  }
  if (kind === "empty") return null;
  if (kind === "label") {
    const { text, label, ...labelProps } = props;
    return (
      <Typography {...labelProps} style={{ fontWeight: field.fontWeight }}>
        {(field.children ?? text ?? label ?? value) as ReactNode}
      </Typography>
    );
  }
  if (kind === "button") {
    const { label, ...buttonProps } = props;
    return (
      <Button {...buttonProps} disabled={Boolean(bound.disabled)} type={(field.inputType ?? "button") as "button" | "submit" | "reset"}>
        {(field.children ?? label) as ReactNode}
      </Button>
    );
  }
  if (!state || !name) throw new Error(`GetForm: field "${type}" requires formik and tag/name.`);
  if (textTypes.includes(kind)) {
    return <TextField fullWidth {...(bound as object)} type={field.inputType ?? kind} />;
  }
  const Control = controls[kind];
  if (!Control) throw new Error(`GetForm: register components["${type}"] for this field type.`);
  if (kind === "switch") return <Control {...bound} value={undefined} checked={Boolean(value)} />;
  if (kind === "folder" && pickFolder && !props.onBrowse) {
    const browse = async () => {
      try {
        const next = await pickFolder((current.current as string | undefined) || undefined);
        if (!next) return;
        change(next);
        void state.setFieldTouched(name, true, false);
        await persist(next);
      } catch (failure) {
        state.setStatus(errorText(failure));
      }
    };
    return <Control fullWidth {...bound} onBrowse={browse} />;
  }
  if (kind === "knob") {
    // RotaryKnob has a value/commit API, not a native input blur/error API.
    return (
      <div onBlur={blur}>
        <Control
          {...props}
          value={value ?? 0}
          disabled={Boolean(bound.disabled)}
          onChange={change}
          onCommit={(next: unknown) => {
            // The knob changes and commits in the same event, before Formik has rendered the new value.
            void state.setFieldTouched(name, true, false);
            if (state.validateOnBlur) void state.validateForm(setIn(state.values, name, parseValue(next)));
            field.onCommit?.(next);
          }}
        />
        {message && (
          <small className="ui-field-message" data-error role="alert">
            {message}
          </small>
        )}
      </div>
    );
  }
  return <Control {...(kind !== "slider" && { fullWidth: true })} {...bound} />;
};
