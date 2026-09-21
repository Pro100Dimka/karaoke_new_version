import type { Language } from "../contracts/models";
import type { MessageTable } from "./messageTable";
import { en } from "./messages.en";
import { ru } from "./messages.ru";
import { uk } from "./messages.uk";

type MessageParams = Readonly<Record<string, string | number>>;

const messages = { en, ru, uk } satisfies Record<Language, MessageTable>;

export type MessageKey = keyof typeof en;

export const text = (language: Language, key: MessageKey, params: MessageParams = {}): string =>
  Object.keys(params).reduce(
    (result, name) => result.replaceAll(`{${name}}`, String(params[name])),
    messages[language][key]
  );
