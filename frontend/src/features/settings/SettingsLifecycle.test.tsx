import { useEffect } from "react";
import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import SettingsModal from "./index";

const { audio, form, state, cleanup } = vi.hoisted(() => ({
  audio: vi.fn(() => ({ ready: false, audio: {} })),
  cleanup: vi.fn(), form: vi.fn(), state: { settingsOpen: false, settingsTab: "appearance", setSettingsOpen: vi.fn() },
}));
vi.mock("../../app/AppContext", () => ({ useSettingsDialog: () => state }));
vi.mock("./settingsForm", () => ({ useSettingsForm: form }));
vi.mock("./tabs/Audio/useAudioSettings", () => ({ useAudioSettings: () => { useEffect(() => cleanup, []); return audio(); } }));
vi.mock("../../i18n/useText", () => ({ useText: () => (key: string) => key }));

it("does not create form or audio polling lifecycles for a closed dialog", () => {
  const view = render(<SettingsModal />);
  expect(form).not.toHaveBeenCalled();
  expect(audio).not.toHaveBeenCalled();
  view.unmount();
});

it("releases the audio lifecycle when the user closes settings", () => {
  state.settingsOpen = true;
  const view = render(<SettingsModal />);
  expect(audio).toHaveBeenCalledTimes(1);
  state.settingsOpen = false;
  view.rerender(<SettingsModal />);
  expect(cleanup).toHaveBeenCalledTimes(1);
  view.unmount();
});
