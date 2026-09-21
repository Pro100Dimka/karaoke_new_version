import { getIn, setIn } from "formik";
import { useEffect, useId, useRef } from "react";
import { aliases, textTypes } from "./fieldKinds";
import type { FormRow, FormState } from "./types";

export type FieldCommit = (name: string, value: unknown) => Promise<void> | void;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Binds one form row to Formik: reads the value and error, parses input, and persists a committed value
 * (on blur for text-like controls, on change for the rest) unless a newer edit has overtaken it.
 */
export default function useFieldBinding(row: FormRow, formik: FormState | undefined, onFieldCommit?: FieldCommit) {
  const uid = useId().replace(/:/g, "");
  const {
    type = "SimpleTextField",
    key: _rowKey,
    tag,
    name = tag,
    formik: rowFormik,
    parse,
    onChange,
    onBlur,
    onSave,
    saveOn,
    valueType,
    validate,
    fieldProps,
    inputType,
    fontWeight,
    children,
    render,
    onCommit,
    ...rowProps
  } = row;
  const props: Record<string, unknown> = { ...rowProps, ...fieldProps };
  const state = rowFormik ?? formik;
  const kind = aliases[type] ?? type;
  const value = name ? getIn(state?.values, name) : undefined;
  const touched = name && (getIn(state?.touched, name) || (state?.submitCount ?? 0) > 0);
  const error = props.error ?? (touched ? getIn(state?.errors, name) : undefined);
  const message = typeof error === "string" ? error : undefined;
  const revision = useRef(0);
  const current = useRef<unknown>(value);
  current.current = value;
  const registerField = state?.registerField;
  const unregisterField = state?.unregisterField;

  useEffect(() => {
    if (!name || !validate) return undefined;
    registerField?.(name, { validate });
    return () => unregisterField?.(name);
  }, [name, validate, registerField, unregisterField]);

  const mode = saveOn ?? (textTypes.includes(kind) || kind === "number" || kind === "folder" ? "blur" : "change");

  const parseValue = (raw: unknown): unknown => {
    if (parse && state) return parse(raw, state);
    if (valueType === "nullable-number" && (raw === "" || raw == null)) return null;
    if ((kind === "number" || valueType === "number" || valueType === "nullable-number") && raw !== "") return Number(raw);
    return raw;
  };

  const persist = async (next: unknown): Promise<void> => {
    if (!state || !name || (!onSave && !onFieldCommit) || props.disabled || props.readOnly || mode === false) return;
    const ticket = ++revision.current;
    try {
      state.setStatus(undefined);
      const errors = await state.validateForm(setIn(state.values, name, next));
      if (ticket !== revision.current || getIn(errors, name)) return;
      if (onSave) await onSave(next);
      else await onFieldCommit?.(name, next);
    } catch (failure) {
      state.setStatus(errorText(failure));
    }
  };

  const change = (raw: unknown, event?: unknown): void => {
    const next = parseValue(raw);
    revision.current += 1;
    current.current = next;
    if (name) void state?.setFieldValue(name, next);
    onChange?.(next, event);
    if (mode === "change") void persist(next);
  };

  const blur = (event?: unknown): void => {
    if (name) void state?.setFieldTouched(name, true);
    onBlur?.(event);
    if (mode === "blur") void persist(current.current);
  };

  const bound: Record<string, unknown> = {
    ...props,
    id: props.id ?? `get-form-${uid}`,
    name,
    disabled: Boolean(state?.isSubmitting || props.disabled),
    value: value ?? "",
    error: message,
    onChange: change,
    onBlur: blur
  };

  return { name, kind, type, state, value, message, props, bound, current, change, blur, persist, parseValue, errorText, inputType, fontWeight, children, render, onCommit };
}
