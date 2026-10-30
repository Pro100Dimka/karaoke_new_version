import { useForm, type FormApi } from "@neo-ui-kit/react";

export default function useSettingsForm<T extends Record<string, unknown>>(
  values: T,
  setValue: (path: string, value: unknown) => void,
): FormApi<T> {
  const form = useForm({ initialValues: values, reinitialize: false });
  return {
    ...form, values, setValue,
    field(path) {
      let value: unknown = values;
      for (const key of path.split("."))
        value = value && typeof value === "object" ? Reflect.get(value, key) : undefined;
      return { ...form.field(path), value, onValueChange: value => setValue(path, value) };
    },
  };
}
