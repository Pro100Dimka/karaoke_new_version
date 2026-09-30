import { Database } from "lucide-react";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { SettingsCard } from "../../SettingsCard";
import { SettingsWaves } from "./Artwork";

it("uses the animated reference-card structure without replacing its real content", () => {
  const { container } = render(
    <SettingsCard icon={Database} title="Память / хранилище" description="Управление кешем">
      <button type="button">Очистить кэш</button>
    </SettingsCard>,
  );

  expect(container.querySelector(".settingsNeonFrame")).toBeInTheDocument();
  expect(container.querySelectorAll(".settings-neon-light-core")).toHaveLength(2);
  expect(container.querySelectorAll(".settings-neon-light-aura")).toHaveLength(2);
  expect(container.querySelector(".settingCardTile")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Память / хранилище" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Очистить кэш" })).toBeInTheDocument();
});

it("keeps every animated wave from the supplied advanced-settings artwork", () => {
  const { container } = render(<SettingsWaves kind="history" />);
  const stylesheet = readFileSync(
    resolve("src/features/settings/tabs/Advanced/advanced.css"),
    "utf8",
  );

  expect(container.querySelectorAll(".settingsWave")).toHaveLength(36);
  expect(stylesheet).not.toContain("url(#history-wave-gradient)");
});
