import { audioClient } from "../../services/audioClient";
import { pythonClient } from "../../services/pythonClient";
import { editorApi } from "./editorApi";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAsk } from "../../app/DialogProvider";
import { useCloseGuard } from "../../app/CloseGuards";
import { useNotify } from "../../app/NotificationsProvider";
import type { ProjectCompatibility } from "../../contracts/clients";
import type { SongDto } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { toAppError } from "../../shared/errors";
import { clearDraft, loadDraft, saveDraft } from "./editorDraft";
import {
  deleteNotes,
  isEditorDirty,
  moveNotes,
  pushHistory,
  redoHistory,
  startHistory,
  undoHistory,
  type EditorDocument,
  type EditorHistory,
} from "../../application/editor/editorModel";
import { useEditorPreview } from "./useEditorPreview";

export type EditorLoad =
  | { kind: "loading" }
  | { kind: "failed" }
  | {
      kind: "invalid";
      compatibility: Exclude<ProjectCompatibility, "Current"> | "NotReady";
    }
  | { kind: "ready"; song: SongDto };

const draftDelayMilliseconds = 600;

export const useEditorSession = (songId: string) => {
  const ask = useAsk();
  const notify = useNotify();
  const t = useText();
  const text = useRef(t);
  text.current = t;

  const [load, setLoad] = useState<EditorLoad>({ kind: "loading" });
  const [history, setHistory] = useState<EditorHistory | null>(null);
  const [saved, setSaved] = useState<EditorDocument | null>(null);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [audioReady, setAudioReady] = useState(false);
  const generation = useRef(0);
  const savingGeneration = useRef<number | null>(null);

  const document = history?.present ?? null;
  const dirty = useMemo(() => document && saved ? isEditorDirty(saved, document) : false, [saved, document]);
  const historyRef = useRef(history);
  historyRef.current = history;
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const song = load.kind === "ready" ? load.song : null;
  const songRef = useRef(song);
  songRef.current = song;
  const previewFailure = useCallback(
    () => notify(t("actionFailed"), "error"),
    [notify, t],
  );
  const preview = useEditorPreview(audioReady, previewFailure);

  // ---- open: compatibility, document, recovery draft, audio preview ----
  useEffect(() => {
    let active = true;
    generation.current += 1;
    setLoad({ kind: "loading" });
    setHistory(null);
    setSaved(null);
    setSaving(false);
    setAudioReady(false);
    void (async () => {
      try {
        const loaded = await pythonClient.getSong(songId);
        if (!active) return;
        if (loaded.status !== "ready")
          return setLoad({ kind: "invalid", compatibility: "NotReady" });
        const compatibility = await pythonClient.projectCompatibility(
          loaded.id,
          loaded.activeRevision,
        );
        if (!active) return;
        if (compatibility !== "Current")
          return setLoad({ kind: "invalid", compatibility });
        const document = await editorApi.load(loaded.id);
        if (!active) return;
        setSaved(document);
        setHistory(startHistory(document));
        setSelection(new Set());
        setLoad({ kind: "ready", song: loaded });

        const draft = loadDraft(loaded.id);
        if (draft && draft.baseRevision === document.revision) {
          const choice = await ask({
            title: text.current("draftFoundTitle"),
            body: text.current("draftFoundBody"),
            tone: "info",
            actions: [
              { id: "discard", label: text.current("discard") },
              {
                id: "restore",
                label: text.current("restoreDraft"),
                appearance: "primary",
              },
            ],
          });
          if (!active) return;
          if (choice === "restore")
            setHistory(pushHistory(startHistory(document), draft.document));
          else clearDraft(loaded.id);
        }
        await audioClient
          .prepareSong(loaded)
          .then(() => active && setAudioReady(true))
          .catch(() => undefined);
      } catch {
        if (active) setLoad({ kind: "failed" });
      }
    })();
    return () => {
      active = false;
      generation.current += 1;
      void audioClient.stop().catch(() => undefined);
    };
  }, [songId, ask, audioClient, pythonClient, editorApi]);

  // ---- crash-recovery draft while dirty ----
  useEffect(() => {
    if (!history || !saved) return;
    if (!dirty) {
      // Keep a found draft until its restore dialog is answered; an undo to saved content needs none.
      if (history.past.length || history.future.length) clearDraft(songId);
      return;
    }
    const timer = window.setTimeout(
      () => saveDraft(songId, { baseRevision: saved.revision, document: history.present }),
      draftDelayMilliseconds,
    );
    return () => window.clearTimeout(timer);
  }, [history, saved, dirty, songId]);

  const edit = useCallback(
    (change: (current: EditorDocument) => EditorDocument) => {
      setHistory((current) =>
        current ? pushHistory(current, change(current.present)) : current,
      );
    },
    [],
  );

  const select = useCallback((id: string, additive: boolean) => {
    setSelection((current) => {
      if (!additive) return new Set([id]);
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const save = useCallback(async (): Promise<boolean> => {
    const target = songRef.current;
    const current = historyRef.current?.present;
    const base = savedRef.current;
    if (!target || !current || !base) return true;
    const requestGeneration = generation.current;
    if (savingGeneration.current === requestGeneration) return false;
    savingGeneration.current = requestGeneration;
    setSaving(true);
    try {
      let expected = base.revision;
      for (;;) {
        try {
          const revision = await editorApi.save(target, current, expected);
          if (requestGeneration !== generation.current) return false;
          const next = { ...current, revision };
          const present = { ...(historyRef.current?.present ?? current), revision };
          const pendingEdits = isEditorDirty(next, present);
          savedRef.current = next;
          dirtyRef.current = pendingEdits;
          setSaved(next);
          setHistory((existing) =>
            existing ? { ...existing, present: { ...existing.present, revision } } : existing,
          );
          if (pendingEdits) saveDraft(target.id, { baseRevision: revision, document: present });
          else clearDraft(target.id);
          notify(t("editorSaved"), "success");
          return !pendingEdits;
        } catch (error) {
          if (requestGeneration !== generation.current) return false;
          if (toAppError(error).code !== "RevisionConflict") throw error;
          const choice = await ask({
            title: t("editorConflictTitle"),
            body: t("editorConflictBody"),
            actions: [
              { id: "cancel", label: t("cancel") },
              { id: "reload", label: t("reloadLatest") },
              {
                id: "overwrite",
                label: t("overwriteLatest"),
                appearance: "primary",
              },
            ],
          });
          if (requestGeneration !== generation.current) return false;
          if (choice === "reload") {
            const latest = await editorApi.load(target.id);
            if (requestGeneration !== generation.current) return false;
            setSaved(latest);
            setHistory(startHistory(latest));
            setSelection(new Set());
            clearDraft(target.id);
            return true;
          }
          if (choice !== "overwrite") return false;
          // Explicit overwrite: adopt the latest revision number, keep the local edits.
          expected = (await editorApi.load(target.id)).revision;
          if (requestGeneration !== generation.current) return false;
        }
      }
    } catch {
      // The edits stay in memory so the user can retry.
      if (requestGeneration === generation.current)
        notify(t("editorSaveFailed"), "error");
      return false;
    } finally {
      if (requestGeneration === generation.current) {
        savingGeneration.current = null;
        setSaving(false);
      }
    }
  }, [ask, notify, t]);

  /** Save / Discard / Cancel; resolves true when the caller may leave. */
  const resolveUnsaved = useCallback(async (): Promise<boolean> => {
    if (!dirtyRef.current) return true;
    const choice = await ask({
      title: t("unsavedEditorTitle"),
      body: t("unsavedEditorBody"),
      actions: [
        { id: "cancel", label: t("cancel") },
        { id: "discard", label: t("discardChanges") },
        { id: "save", label: t("save"), appearance: "primary" },
      ],
    });
    if (choice === "save") return save();
    if (choice === "discard") {
      if (songRef.current) clearDraft(songRef.current.id);
      return true;
    }
    return false;
  }, [ask, save, t]);

  useCloseGuard(resolveUnsaved);

  return {
    load,
    document,
    dirty,
    selection,
    playing: preview.playing,
    position: preview.position,
    saving,
    audioReady,
    canUndo: (history?.past.length ?? 0) > 0,
    canRedo: (history?.future.length ?? 0) > 0,
    setSelection,
    select,
    togglePlay: preview.togglePlay,
    seek: preview.seek,
    save,
    resolveUnsaved,
    undo: () =>
      setHistory((current) => (current ? undoHistory(current) : current)),
    redo: () =>
      setHistory((current) => (current ? redoHistory(current) : current)),
    move: (ids: ReadonlySet<string>, pitch: number, seconds: number) =>
      edit((current) => moveNotes(current, ids, pitch, seconds)),
    remove: (ids: ReadonlySet<string>) => {
      edit((current) => deleteNotes(current, ids));
      setSelection(new Set());
    },
    /** Continuous drags call this with previews; only the final drop becomes one undo step. */
    replacePresent: (next: EditorDocument) =>
      setHistory((current) =>
        current ? { ...current, present: next } : current,
      ),
    commit: (before: EditorDocument, after: EditorDocument) =>
      setHistory((current) =>
        current ? pushHistory({ ...current, present: before }, after) : current,
      ),
  };
};
