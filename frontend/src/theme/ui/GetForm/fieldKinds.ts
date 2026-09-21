import type { ComponentType } from "react";
import FolderField from "../FolderField";
import NumberField from "../NumberField";
import RotaryKnob from "../RotaryKnob";
import Select from "../Select";
import Slider from "../Slider";
import Switch from "../Switch";

/** Wire boundary: every control is driven through the same untyped prop bag built from a form row. */
export type ControlComponent = ComponentType<Record<string, unknown>>;

export const aliases: Readonly<Record<string, string>> = {
  SimpleTextField: "text",
  TextField: "text",
  PasswordTextField: "password",
  NumberField: "number",
  SelectField: "select",
  Select: "select",
  SwitchField: "switch",
  Switch: "switch",
  CheckboxField: "switch",
  DateTextField: "date",
  DateAndTimePicker: "datetime-local",
  MobilePhone: "tel",
  FolderField: "folder",
  Slider: "slider",
  RotaryKnob: "knob",
  ButtonField: "button",
  Text: "label",
  Label: "label",
  Empty: "empty"
};

export const controls: Readonly<Record<string, ControlComponent>> = {
  number: NumberField as unknown as ControlComponent,
  select: Select as unknown as ControlComponent,
  switch: Switch as unknown as ControlComponent,
  folder: FolderField as unknown as ControlComponent,
  slider: Slider as unknown as ControlComponent,
  knob: RotaryKnob as unknown as ControlComponent
};

export const textTypes: readonly string[] = ["text", "password", "date", "datetime-local", "tel", "email", "url", "time"];
export const breakpoints = ["xs", "sm", "md", "lg", "xl"] as const;
