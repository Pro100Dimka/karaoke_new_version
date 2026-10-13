import { expect, it } from "vitest";
import { installedAppUserModelId, notificationIdentity, notificationRegistryCommands } from "./NotificationIdentity";

it("names every run A&D Voice, keeping the installed app, the checkout and test profiles apart", () => {
  expect(notificationIdentity("AD Voice")).toEqual({ id: installedAppUserModelId, displayName: "A&D Voice" });
  expect(notificationIdentity("AD Voice Dev")).toEqual({ id: "ADVoice.App.Dev", displayName: "A&D Voice" });
  expect(notificationIdentity("AD Voice Multi 2")).toEqual({ id: "ADVoice.App.Multi2", displayName: "A&D Voice · Multi 2" });
  expect(notificationIdentity("Something")).toEqual({ id: "ADVoice.App.Something", displayName: "A&D Voice · Something" });
});

it("registers the display name and icon for the current user only", () => {
  const key = String.raw`HKCU\Software\Classes\AppUserModelId\ADVoice.App.Dev`;
  expect(notificationRegistryCommands("ADVoice.App.Dev", "A&D Voice", "D:/icons/dark.png")).toEqual([
    ["add", key, "/v", "DisplayName", "/t", "REG_SZ", "/d", "A&D Voice", "/f"],
    ["add", key, "/v", "IconUri", "/t", "REG_SZ", "/d", "D:/icons/dark.png", "/f"],
  ]);
  expect(notificationRegistryCommands("ADVoice.App", "A&D Voice", null)).toHaveLength(1);
});
