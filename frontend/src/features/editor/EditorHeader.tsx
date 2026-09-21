import { Button, IconButton } from "../../theme/ui";
import {
  ArrowLeft,
  ArrowLeftToLine,
  ArrowRightToLine,
  Crosshair,
  Merge,
  Redo2,
  RotateCcw,
  Save,
  Trash2,
  Undo2,
  type LucideIcon
} from "lucide-react";
import type { MessageKey } from "../../i18n/messages";
import { useText } from "../../i18n/useText";

interface EditorAction {
  id: string;
  label: MessageKey;
  icon: LucideIcon;
  disabled: boolean;
  primary?: boolean;
  run(): void;
}

export interface EditorHeaderProps {
  title: string;
  revision: number;
  dirty: boolean;
  saving: boolean;
  canUndo: boolean;
  canRedo: boolean;
  hasSelection: boolean;
  canMerge: boolean;
  onBack(): void;
  onUndo(): void;
  onRedo(): void;
  onRestore(): void;
  onSave(): void;
  onDelete(): void;
  onMerge(): void;
  onLocate(): void;
  onAlignStart(): void;
  onAlignEnd(): void;
}

export const EditorHeader = (props: EditorHeaderProps) => {
  const t = useText();
  const actions = [
    { id: "undo", label: "undo", icon: Undo2, disabled: !props.canUndo, run: props.onUndo },
    { id: "redo", label: "redo", icon: Redo2, disabled: !props.canRedo, run: props.onRedo },
    { id: "delete", label: "deleteNotes", icon: Trash2, disabled: !props.hasSelection, run: props.onDelete },
    { id: "merge", label: "mergeNotes", icon: Merge, disabled: !props.canMerge, run: props.onMerge },
    { id: "locate", label: "locateSelection", icon: Crosshair, disabled: !props.hasSelection, run: props.onLocate },
    { id: "alignStart", label: "alignStart", icon: ArrowLeftToLine, disabled: !props.hasSelection, run: props.onAlignStart },
    { id: "alignEnd", label: "alignEnd", icon: ArrowRightToLine, disabled: !props.hasSelection, run: props.onAlignEnd },
    { id: "restore", label: "restoreOriginal", icon: RotateCcw, disabled: props.saving, run: props.onRestore },
    { id: "save", label: "save", icon: Save, disabled: !props.dirty || props.saving, primary: true, run: props.onSave }
  ] satisfies readonly EditorAction[];

  return (
    <header className="editorHeader">
      <Button variant="outlined" tone="neutral" startIcon={<ArrowLeft size={18} />} onClick={props.onBack}>
        {t("back")}
      </Button>
      <div className="editorTitle">
        <h1>{t("melodyEditor")}</h1>
        <span>
          {props.title} · {t(props.dirty ? "editorRevisionUnsaved" : "editorRevision", { revision: props.revision })}
        </span>
      </div>
      <div className="editorActions" role="toolbar" aria-label={t("melodyEditor")}>
        {actions.map(action => (
          <IconButton
            key={action.id}
            variant={action.primary ? "contained" : "ghost"}
            icon={action.icon}
            label={t(action.label)}
            disabled={action.disabled}
            onClick={action.run}
          />
        ))}
      </div>
    </header>
  );
};
