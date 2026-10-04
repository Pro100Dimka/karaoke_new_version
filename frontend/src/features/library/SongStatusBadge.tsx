import { Badge } from "@ad-voice/ui";
import type { SongStatus } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { songStatusPresentation } from "./songPresentation";

const badgeTone = { default: "offline", primary: "processing", success: "success", danger: "error" } as const;

export const SongStatusBadge = ({ status }: { status: SongStatus }) => {
  const t = useText();
  const presentation = songStatusPresentation[status];
  return <Badge size="sm" tone={badgeTone[presentation.tone]}>{t(presentation.label)}</Badge>;
};
