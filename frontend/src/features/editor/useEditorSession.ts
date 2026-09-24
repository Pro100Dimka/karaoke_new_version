import { useCallback, useEffect, useRef, useState } from "react";
import { useAsk } from "../../app/DialogProvider";
import { useCloseGuard } from "../../app/CloseGuards";
import { useNotify } from "../../app/NotificationsProvider";
import type { ProjectCompatibility } from "../../contracts/clients";
import type { SongDto } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { audioClient } from "../../services/audioClient";
import { pythonClient } from "../../services/pythonClient";
import { toAppError } from "../../shared/errors";
import { editorApi } from "./editorApi";
import { clearDraft, loadDraft, saveDraft } from "./editorDraft";
import {
  alignBoundary,
  deleteNotes,
  isEditorDirty,
  mergeNotes,
  moveNotes,
  pushHistory,
  redoHistory,
  resizeNote,
  startHistory,
  undoHistory,
  type EditorDocument,
  type EditorHistory
} from "./editorModel";
import { useEditorPreview } from "./useEditorPreview";

export type EditorLoad =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "invalid"; compatibility: Exclude<ProjectCompatibility, "Current"> | "NotReady" }
  | { kind: "ready"; song: SongDto };

const draftDelayMilliseconds = 600;

export const useEditorSession = (songId: string) => {
  const ask = useAsk();
  const notify = useNotify();
  const t = useText();

  const [load, setLoad] = useState<EditorLoad>({ kind: "loading" });
  const [history, setHistory] = useState<EditorHistory | null>(null);
  const [saved, setSaved] = useState<EditorDocument | null>(null);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [audioReady, setAudioReady] = useState(false);

  const document = history?.present ?? null;
  const dirty = document && saved ? isEditorDirty(saved, document) : false;
  const historyRef = useRef(history);
  historyRef.current = history;
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const song = load.kind === "ready" ? load.song : null;
  const songRef = useRef(song);
  songRef.current = song;
  const previewFailure = useCallback(() => notify(t("actionFailed"), "error"), [notify, t]);
  const preview = useEditorPreview(audioReady, previewFailure);

  // ---- open: compatibility, document, recovery draft, audio preview ----
  useEffect(() => {
    let active = true;
    setLoad({ kind: "loading" });
    setHistory(null);
    void (async () => {
      try {
        const loaded = await pythonClient.getSong(songId);
        if (!active) return;
        if (loaded.status !== "ready") return setLoad({ kind: "invalid", compatibility: "NotReady" });
        const compatibility = await pythonClient.projectCompatibility(loaded.id, loaded.activeRevision);
        if (!active) return;
        if (compatibility !== "Current") return setLoad({ kind: "invalid", compatibility });
        const document = await editorApi.load(loaded.id);
        if (!active) return;
        setSaved(document);
        setHistory(startHistory(document));
        setSelection(new Set());
        setLoad({ kind: "ready", song: loaded });

        const draft = loadDraft(loaded.id);
        if (draft && draft.baseRevision === document.revision) {
          const choice = await ask({
            title: t("draftFoundTitle"),
            body: t("draftFoundBody"),
            tone: "info",
            actions: [
              { id: "discard", label: t("discard") },
              { id: "restore", label: t("restoreDraft"), appearance: "primary" }
            ]
          });
          if (!active) return;
          if (choice === "restore") setHistory(pushHistory(startHistory(document), draft.document));
          else clearDraft(loaded.id);
        }
        await audioClient.prepareSong(loaded).then(() => active && setAudioReady(true)).catch(() => undefined);
      } catch {
        if (active) setLoad({ kind: "failed" });
      }
    })();
    return () => {
      active = false;
      void audioClient.stop().catch(() => undefined);
    };
  }, [songId, ask, t]);

  // ---- crash-recovery draft while dirty ----
  useEffect(() => {
    if (!document || !saved || !dirty) return;
    const timer = window.setTimeout(
      () => saveDraft(songId, { baseRevision: saved.revision, document }),
      draftDelayMilliseconds
    );
    return () => window.clearTimeout(timer);
  }, [document, saved, dirty, songId]);

  const edit = useCallback((change: (current: EditorDocument) => EditorDocument) => {
    setHistory(current => (current ? pushHistory(current, change(current.present)) : current));
  }, []);

  const select = useCallback((id: string, additive: boolean) => {
    setSelection(current => {
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
    setSaving(true);
    try {
      let expected = base.revision;
      for (;;) {
        try {
          const revision = await editorApi.save(target, current, expected);
          const next = { ...current, revision };
          setSaved(next);
          setHistory(existing => (existing ? { ...existing, present: next } : existing));
          clearDraft(target.id);
          notify(t("editorSaved"), "success");
          return true;
        } catch (error) {
          if (toAppError(error).code !== "RevisionConflict") throw error;
          const choice = await ask({
            title: t("editorConflictTitle"),
            body: t("editorConflictBody"),
            actions: [
              { id: "cancel", label: t("cancel") },
              { id: "reload", label: t("reloadLatest") },
              { id: "overwrite", label: t("overwriteLatest"), appearance: "primary" }
            ]
          });
          if (choice === "reload") {
            const latest = await editorApi.load(target.id);
            setSaved(latest);
            setHistory(startHistory(latest));
            setSelection(new Set());
            clearDraft(target.id);
            return true;
          }
          if (choice !== "overwrite") return false;
          // Explicit overwrite: adopt the latest revision number, keep the local edits.
          expected = (await editorApi.load(target.id)).revision;
        }
      }
    } catch {
      // The edits stay in memory so the user can retry.
      notify(t("editorSaveFailed"), "error");
      return false;
    } finally {
      setSaving(false);
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
        { id: "save", label: t("save"), appearance: "primary" }
      ]
    });
    if (choice === "save") return save();
    if (choice === "discard") {
      if (songRef.current) clearDraft(songRef.current.id);
      return true;
    }
    return false;
  }, [ask, save, t]);

  useCloseGuard(resolveUnsaved);

  const restore = useCallback(async () => {
    const target = songRef.current;
    const base = savedRef.current;
    if (!target || !base) return;
    const choice = await ask({
      title: t("restoreOriginalTitle"),
      body: t("restoreOriginalBody"),
      actions: [
        { id: "cancel", label: t("cancel") },
        { id: "restore", label: t("restore"), appearance: "primary" }
      ]
    });
    if (choice !== "restore") return;
    if (dirtyRef.current && !(await resolveUnsaved())) return;
    try {
      await editorApi.reset(target.id, base.revision);
      const latest = await editorApi.load(target.id);
      setSaved(latest);
      setHistory(startHistory(latest));
      setSelection(new Set());
      clearDraft(target.id);
    } catch {
      notify(t("actionFailed"), "error");
    }
  }, [ask, notify, resolveUnsaved, t]);

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
    restore,
    resolveUnsaved,
    undo: () => setHistory(current => (current ? undoHistory(current) : current)),
    redo: () => setHistory(current => (current ? redoHistory(current) : current)),
    move: (ids: ReadonlySet<string>, pitch: number, seconds: number) => edit(current => moveNotes(current, ids, pitch, seconds)),
    resize: (id: string, edge: "start" | "end", seconds: number) => edit(current => resizeNote(current, id, edge, seconds)),
    remove: (ids: ReadonlySet<string>) => {
      edit(current => deleteNotes(current, ids));
      setSelection(new Set());
    },
    merge: (ids: ReadonlySet<string>) => edit(current => mergeNotes(current, ids)),
    align: (ids: ReadonlySet<string>, edge: "start" | "end", seconds: number) =>
      edit(current => alignBoundary(current, ids, edge, seconds)),
    /** Continuous drags call this with previews; only the final drop becomes one undo step. */
    replacePresent: (next: EditorDocument) => setHistory(current => (current ? { ...current, present: next } : current)),
    commit: (before: EditorDocument, after: EditorDocument) =>
      setHistory(current => (current ? pushHistory({ ...current, present: before }, after) : current))
  };
};
