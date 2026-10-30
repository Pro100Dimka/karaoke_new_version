import { Badge, tr, useLocale } from "@neo-ui-kit/react";
import type { SongStatus } from "../../../contracts/models";
import { ru } from "../../../i18n/messages.ru";
import { songStatusPresentation } from "./songPresentation";

const badgeTone = {
  default: "offline",
  primary: "processing",
  success: "success",
  danger: "error",
} as const;

export const SongStatusBadge = ({ status }: { status: SongStatus }) => {
  useLocale();
  const presentation = songStatusPresentation[status];
  return (
    <Badge size="sm" tone={badgeTone[presentation.tone]} style={{ alignSelf: "start" }}>
      {tr(ru[presentation.label])}
    </Badge>
  );
};
