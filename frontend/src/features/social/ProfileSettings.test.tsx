import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ProfileSettings } from "./ProfileSettings";

vi.mock("../../i18n/useText", () => ({ useText: () => (key: string) => key }));
vi.mock("../../app/AppContext", () => ({
  useApp: () => ({ preferences: { displayName: "Yojik", profilePhoto: "" }, updatePreferences: vi.fn() }),
}));
vi.mock("../../app/DialogProvider", () => ({ useAsk: () => vi.fn() }));
vi.mock("../../app/NotificationsProvider", () => ({ useNotify: () => vi.fn() }));
vi.mock("./SocialContext", () => ({
  useSocial: () => ({ type: "inbox", me: { accountId: "me", displayName: "Yojik", friendCode: "CODE", transferCode: "TRANSFER", avatarVersion: 0 } }),
}));
vi.mock("./useSocialAction", () => ({ useSocialAction: () => ({ busy: false, run: vi.fn() }) }));
vi.mock("./PersonAvatar", () => ({ PersonAvatar: () => <div data-testid="avatar" /> }));

it("keeps photo controls in the profile without showing account-transfer controls", () => {
  render(<ProfileSettings />);

  expect(screen.getByRole("button", { name: "choosePhoto" })).toBeInTheDocument();
  expect(screen.queryByText("transferCode")).not.toBeInTheDocument();
  expect(screen.queryByText("showTransferCode")).not.toBeInTheDocument();
  expect(screen.queryByText("transferAccount")).not.toBeInTheDocument();
});
