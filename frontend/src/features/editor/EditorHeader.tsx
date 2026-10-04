import { createPortal } from "react-dom";
import { Badge, Button, IconButton, Planet, Toolbar, Typography } from "@ad-voice/ui";
import { titleBarLeadingId } from "../../app/TitleBar";
import { useText } from "../../i18n/useText";

interface EditorHeaderProps {
  title: string;
  revision: number;
  dirty: boolean;
  saving: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onBack(): void;
  onUndo(): void;
  onRedo(): void;
  onSave(): void;
}

/** The editor's banner: what is being edited, its revision, history and saving; the way back sits in the title bar. */
export const EditorHeader = ({ title, revision, dirty, saving, canUndo, canRedo, onBack, onUndo, onRedo, onSave }: EditorHeaderProps) => {
  const t = useText();
  const slot = document.getElementById(titleBarLeadingId);
  const back = <IconButton round size="lg" icon="back" label={t("library")} onClick={onBack} />;

  return (
    <header className="editorHeader">
      {slot ? createPortal(back, slot) : back}
      <Planet className="editorPlanet" />
      <div className="editorTitle">
        <Typography variant="eyebrow" tone="accent">{t("melodyEditor")}</Typography>
        <Typography as="h1" variant="h3" truncate>{title}</Typography>
        <span className="editorRevision">
          <Typography variant="caption" tone="muted">{t("editorRevision", { revision })}</Typography>
          {dirty && <Badge tone="warning">{t("editorUnsaved")}</Badge>}
        </span>
      </div>
      <Toolbar className="editorActions" aria-label={t("editorHistory")}>
        <IconButton icon="undo" label={t("undo")} disabled={!canUndo} onClick={onUndo} />
        <IconButton icon="redo" label={t("redo")} disabled={!canRedo} onClick={onRedo} />
        <Button variant="primary" icon="save" loading={saving} disabled={!dirty} onClick={onSave}>{t("save")}</Button>
      </Toolbar>
    </header>
  );
};
