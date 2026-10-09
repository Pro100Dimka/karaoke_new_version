import { StrictMode, useEffect } from "react";
import { render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import SettingsModal from "./index";

const { audio, form, state, cleanup } = vi.hoisted(() => ({
  audio: vi.fn(() => ({ ready: false, audio: {} })),
  cleanup: vi.fn(), form: vi.fn(), state: { settingsOpen: false, settingsTab: "audio", setSettingsOpen: vi.fn() },
}));
vi.mock("../../app/AppContext", () => ({ useSettingsDialog: () => state }));
vi.mock("@ad-voice/ui", async (importOriginal) => ({
  ...await importOriginal<typeof import("@ad-voice/ui")>(),
  useFormContext: () => ({}),
}));
vi.mock("./settingsForm", () => ({ useSettingsForm: form }));
vi.mock("./tabs/Audio/useAudioSettings", () => ({ useAudioSettings: () => { useEffect(() => cleanup, []); return audio(); } }));
vi.mock("../../i18n/useText", () => ({ useText: () => (key: string) => key }));

it("does not create form or audio polling lifecycles for a closed dialog", () => {
  const view = render(<SettingsModal />);
  expect(form).not.toHaveBeenCalled();
  expect(audio).not.toHaveBeenCalled();
  view.unmount();
});

it("releases the audio lifecycle when the user closes settings", async () => {
  state.settingsOpen = true;
  const view = render(<SettingsModal />);
  await waitFor(() => expect(audio).toHaveBeenCalledTimes(1));
  state.settingsOpen = false;
  view.rerender(<SettingsModal />);
  expect(cleanup).toHaveBeenCalledTimes(1);
  view.unmount();
});

it("opens the native settings modal once under StrictMode", () => {
  const originalOpen = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
  const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
  const showModal = vi.fn(function (this: HTMLDialogElement) {
    expect(form).not.toHaveBeenCalled();
    this.setAttribute("open", "");
  });
  const close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: showModal });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: close });
  form.mockClear();
  state.settingsOpen = true;
  let view: ReturnType<typeof render> | undefined;
  try {
    view = render(<StrictMode><SettingsModal /></StrictMode>);
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    view.unmount();
    view = undefined;
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    view?.unmount();
    if (originalOpen) Object.defineProperty(HTMLDialogElement.prototype, "showModal", originalOpen);
    else delete (HTMLDialogElement.prototype as { showModal?: unknown }).showModal;
    if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, "close", originalClose);
    else delete (HTMLDialogElement.prototype as { close?: unknown }).close;
    state.settingsOpen = false;
  }
});
