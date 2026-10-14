import { render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { FormApi } from "@neo-ui-kit/react";
import type { SettingsFormValues } from "../settings/settingsForm";
import { ProfileSettings } from "./ProfileSettings";

const mocks = vi.hoisted(() => ({
  photo: "data:image/webp;base64,bG9jYWw=",
  inbox: { type: "inbox", me: { accountId: "me", displayName: "FIRE PEPPER", avatarVersion: 3 } } as const,
}));

vi.mock("../../app/AppContext", () => ({
  useApp: () => ({
    preferences: { profilePhoto: mocks.photo, displayName: "FIRE PEPPER", language: "ru" },
    updatePreferences: vi.fn(),
  }),
}));
vi.mock("../../app/NotificationsProvider", () => ({ useNotify: () => vi.fn() }));
vi.mock("../../i18n/useText", () => ({ useText: () => (key: string) => key }));
vi.mock("../../app/SocialProvider", () => {
  const directory = { avatar: vi.fn(), setAvatar: vi.fn() };
  return { useSocial: () => mocks.inbox, useSocialDirectory: () => directory };
});

it("shows the saved photo when Settings is opened again", async () => {
  const form = { values: { theme: "dark" }, setValue: vi.fn() } as unknown as FormApi<SettingsFormValues>;
  const { container } = render(<ProfileSettings form={form} />);

  // The host seal draws the photo inside its SVG artwork.
  await waitFor(() => expect(container.innerHTML).toContain(mocks.photo));
});
