import { createPortal } from 'react-dom';
import {
  Badge,
  Button,
  IconButton,
  Planet,
  Toolbar,
  Typography,
  tr,
  useLocale,
} from '@neo-ui-kit/react';
import { titleBarLeadingId } from '../../app/TitleBar';

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
      label={tr('library')}
      onClick={onBack}
    />
  );

  return (
    <header className="editorHeader" data-window-drag>
      {slot ? createPortal(back, slot) : back}
      <Planet className="editorPlanet" />
      <div className="editorTitle">
        <Typography as="h1" variant="body" truncate>
          {title}
        </Typography>
        <span className="editorRevision">
          <Typography variant="caption" tone="accent">
            {tr('melodyEditor')}
          </Typography>
          <Typography variant="caption" tone="muted">
            {tr('editorRevision', { revision })}
          </Typography>
          {dirty && <Badge tone="warning">{tr('editorUnsaved')}</Badge>}
        </span>
      </div>
      <Toolbar className="editorActions" aria-label={tr('editorHistory')}>
        <IconButton
          size="sm"
          icon="undo"
          label={tr('undo')}
          disabled={!canUndo}
          onClick={onUndo}
        />
        <IconButton
          size="sm"
          icon="redo"
          label={tr('redo')}
          disabled={!canRedo}
          onClick={onRedo}
        />
        <Button
          size="sm"
          variant="primary"
          icon="save"
          loading={saving}
          disabled={!dirty}
          onClick={onSave}
          label={tr('save')}
        />
      </Toolbar>
    </header>
  );
};
