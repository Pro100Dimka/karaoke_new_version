import { createPortal } from "react-dom";
import { Badge, Button, IconButton, Planet, Toolbar, Typography, tr, useLocale } from "@neo-ui-kit/react";
import { titleBarLeadingId } from "../../app/TitleBar";
import { ru } from "../../i18n/messages.ru";

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
export const EditorHeader = ({
  title,
  revision,
  dirty,
  saving,
  canUndo,
  canRedo,
  onBack,
  onUndo,
  onRedo,
  onSave,
}: EditorHeaderProps) => {
  useLocale();
  const slot = document.getElementById(titleBarLeadingId);
  const back = (
    <IconButton
      round
      size="lg"
      icon="back"
      label={tr(ru.library)}
      onClick={onBack}
    />
  );

  return (
    <header className="editorHeader" data-window-drag>
      {slot ? createPortal(back, slot) : back}
      <Planet className="editorPlanet" />
      <div className="editorTitle">
        <Typography variant="eyebrow" tone="accent">
          {tr(ru.melodyEditor)}
        </Typography>
        <Typography as="h1" variant="h3" truncate>
          {title}
        </Typography>
        <span className="editorRevision">
          <Typography variant="caption" tone="muted">
            {tr(ru.editorRevision, { revision })}
          </Typography>
          {dirty && <Badge tone="warning">{tr(ru.editorUnsaved)}</Badge>}
        </span>
      </div>
      <Toolbar className="editorActions" aria-label={tr(ru.editorHistory)}>
        <IconButton
          icon="undo"
          label={tr(ru.undo)}
          disabled={!canUndo}
          onClick={onUndo}
        />
        <IconButton
          icon="redo"
          label={tr(ru.redo)}
          disabled={!canRedo}
          onClick={onRedo}
        />
        <Button
          variant="primary"
          icon="save"
          loading={saving}
          disabled={!dirty}
          onClick={onSave}
        >
          {tr(ru.save)}
        </Button>
      </Toolbar>
    </header>
  );
};
