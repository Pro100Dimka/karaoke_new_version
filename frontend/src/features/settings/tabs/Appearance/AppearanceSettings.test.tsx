import { fireEvent, render, screen } from "@testing-library/react";
import { Form, useForm } from "@ad-voice/ui";
import { beforeEach, expect, it, vi } from "vitest";
import { defaultPreferences } from "../../../../shared/preferences/preferences";
import { toSettingsFormValues } from "../../settingsForm";
import { AppearanceSettings } from ".";

const state = vi.hoisted(() => ({
  updatePreferences: vi.fn(),
  setStation: vi.fn(),
}));

vi.mock("../../../../app/AppContext", () => ({
  useApp: () => ({
    language: "en",
    preferences: {
      displayName: "Singer",
      language: "en",
      headingFont: "melodix",
      textFont: "melodixText",
      reducedMotion: false,
      theme: "dark",
    },
    updatePreferences: state.updatePreferences,
  }),
}));

vi.mock("../../../../app/RadioContext", () => ({
  useRadio: () => ({
    enabled: false,
    stationId: "lofi",
    volume: 35,
    canControl: true,
    toggle: vi.fn(),
    setStation: state.setStation,
    setVolume: vi.fn(),
  }),
}));

vi.mock("../../../../i18n/useText", () => ({
  useText: () => (key: string) => key,
}));

vi.mock("../../../social/ProfileSettings", () => ({
  ProfileSettings: () => null,
}));

vi.mock("./KeyboardLighting", () => ({
  KeyboardLightingSettings: () => null,
}));

beforeEach(() => vi.clearAllMocks());

const View = () => {
  const initial = defaultPreferences();
  const form = useForm({
    initialValues: {
      ...toSettingsFormValues(initial, "groove-salad"),
      displayName: "Singer",
    },
  });
  return (
    <Form form={form}>
      <AppearanceSettings form={form} />
      <output data-testid="name">{form.values.displayName}</output>
      <output data-testid="motion">{String(form.values.reducedMotion)}</output>
    </Form>
  );
};

it("renders FormFields from the shared settings form and updates that form", () => {
  render(<View />);

  fireEvent.click(screen.getByLabelText("reduceAnimations"));
  expect(screen.getByTestId("motion")).toHaveTextContent("true");
  expect(screen.getAllByText("radioStation")).toHaveLength(1);
});
