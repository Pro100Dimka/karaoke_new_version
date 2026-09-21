import type { en } from "./messages.en";

export type MessageTable = Record<keyof typeof en, string>;
