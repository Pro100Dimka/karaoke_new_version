import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppProvider } from "../../../app/AppContext";
import RenderFormikFields from "./RenderFormikFields";
import useGetForm from "./useGetForm";
import mergeProperties from "./mergeProperties";
import type { FormRow } from "./types";

interface Values {
  name: string;
  audio: { rate: number };
  enabled: boolean;
}

const Harness = ({ rows, onFieldCommit, validate }: { rows: FormRow[]; onFieldCommit?: (name: string, value: unknown) => void; validate?: (values: Values) => Partial<Record<keyof Values, string>> }) => {
  const formik = useGetForm<Values>({ initialValues: { name: "Anna", audio: { rate: 48000 }, enabled: false }, validate, onSubmit: () => undefined });
  return (
    <form onSubmit={formik.handleSubmit}>
      <RenderFormikFields formik={formik} items={rows} onFieldCommit={onFieldCommit} />
    </form>
  );
};
const renderForm = (props: Parameters<typeof Harness>[0]) =>
  render(
    <AppProvider>
      <Harness {...props} />
    </AppProvider>
  );

describe("RenderFormikFields", () => {
  it("shows the initial value of a text row by its label", () => {
    renderForm({ rows: [{ tag: "name", label: "Name" }] });
    expect(screen.getByLabelText("Name")).toHaveValue("Anna");
  });

  it("commits a text row on blur with the typed value, not on every keystroke", async () => {
    const commit = vi.fn();
    renderForm({ rows: [{ tag: "name", label: "Name" }], onFieldCommit: commit });
    const input = screen.getByLabelText("Name");
    fireEvent.change(input, { target: { value: "Bob" } });
    expect(commit).not.toHaveBeenCalled();
    fireEvent.blur(input);
    await waitFor(() => expect(commit).toHaveBeenCalledWith("name", "Bob"));
  });

  it("reads and writes nested paths", () => {
    renderForm({ rows: [{ tag: "audio.rate", type: "NumberField", label: "Rate" }] });
    expect(screen.getByLabelText("Rate")).toHaveValue(48000);
  });

  it("does not persist a value that fails validation", async () => {
    const commit = vi.fn();
    renderForm({
      rows: [{ tag: "name", label: "Name" }],
      onFieldCommit: commit,
      validate: values => (values.name.trim() ? {} : { name: "required" })
    });
    const input = screen.getByLabelText("Name");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(await screen.findByText("required")).toBeInTheDocument();
    expect(commit).not.toHaveBeenCalled();
  });

  it("hides a row while its showFor predicate is false", () => {
    renderForm({ rows: [{ tag: "name", label: "Name", showFor: () => false }] });
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });

  it("uses a row's own onSave instead of the form-wide commit", async () => {
    const commit = vi.fn();
    const save = vi.fn();
    renderForm({ rows: [{ tag: "name", label: "Name", onSave: save }], onFieldCommit: commit });
    const input = screen.getByLabelText("Name");
    fireEvent.change(input, { target: { value: "Cy" } });
    fireEvent.blur(input);
    await waitFor(() => expect(save).toHaveBeenCalledWith("Cy"));
    expect(commit).not.toHaveBeenCalled();
  });
});

describe("mergeProperties", () => {
  it("keeps only the keys of the template and nulls the ones the source lacks", () => {
    expect(mergeProperties({ a: "", b: 0 }, { a: "x", extra: 1 })).toEqual({ a: "x", b: null });
  });

  it("ignores prototype-polluting keys", () => {
    const merged = mergeProperties({ a: "" }, JSON.parse('{"__proto__":{"polluted":true},"a":"x"}'));
    expect(merged).toEqual({ a: "x" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
