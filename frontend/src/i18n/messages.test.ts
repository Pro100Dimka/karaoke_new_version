import { describe, expect, it } from "vitest";
import { en } from "./messages.en";
import { ru } from "./messages.ru";
import { uk } from "./messages.uk";

const entriesMatching = (table: Record<string, string>, pattern: RegExp) =>
  Object.entries(table).filter(([, value]) => pattern.test(value)).map(([key]) => key);

describe("message tables", () => {
  it("never shows Russian-only letters in the Ukrainian interface", () => {
    expect(entriesMatching(uk, /[ыэъёЫЭЪЁ]/)).toEqual([]);
  });

  it("never shows Cyrillic in the English interface", () => {
    expect(entriesMatching(en, /[Ѐ-ӿ]/)).toEqual([]);
  });

  it("never shows Ukrainian-only letters in the Russian interface", () => {
    expect(entriesMatching(ru, /[іїєґІЇЄҐ]/)).toEqual([]);
  });

  it("keeps the same placeholders in every language", () => {
    const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
    const mismatched = (Object.keys(en) as (keyof typeof en)[]).filter(key =>
      String(placeholders(ru[key])) !== String(placeholders(en[key]))
      || String(placeholders(uk[key])) !== String(placeholders(en[key])));
    expect(mismatched).toEqual([]);
  });
});
