import type { SongStatus } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { Chip } from "../../theme/ui";
import { songStatusPresentation } from "./songPresentation";

export const SongStatusBadge = ({ status }: { status: SongStatus }) => {
  const t = useText();
  const presentation = songStatusPresentation[status];

  return (
    <Chip tone={presentation.tone} size="sm">
      {t(presentation.label)}
    </Chip>
  );
};
