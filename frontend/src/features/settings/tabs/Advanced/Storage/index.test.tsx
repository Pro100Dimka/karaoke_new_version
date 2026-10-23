import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StoragePanel } from ".";

vi.mock("../../../../../app/SettingsProvider", () => ({ useSettingsBackend: () => ({}) }));
vi.mock("../../../../../app/DialogProvider", () => ({ useAsk: () => vi.fn() }));
vi.mock("../../../../../app/NotificationsProvider", () => ({ useNotify: () => vi.fn() }));
vi.mock("../../../../../i18n/useText", () => ({ useText: () => (key: string, values?: Record<string, string>) =>
  `${key} ${Object.values(values ?? {}).join(" ")}`.trim() }));
afterEach(cleanup);

it("reports application size separately from free space without a fictitious capacity", () => {
  render(<StoragePanel usage={{ free: 1000, songs: 100, models: 200, cache: 0, recordings: 0, temp: 0 }} onChanged={vi.fn()} />);
  expect(screen.queryByRole("progressbar", { name: "storage" })).not.toBeInTheDocument();
  expect(screen.getByText("storageUsed 300 B")).toBeInTheDocument();
  expect(screen.getByText("storageFree 1000 B")).toBeInTheDocument();
});
