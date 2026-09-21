import { describe, expect, it } from "vitest";
import {
  alignBoundary,
  canMerge,
  deleteNotes,
  isEditorDirty,
  mergeNotes,
  moveNotes,
  pushHistory,
  redoHistory,
  resizeNote,
  snapTime,
  startHistory,
  undoHistory,
  validateDocument,
  type EditorDocument
} from "./editorModel";

const document: EditorDocument = {
  revision: 3,
  words: [
    { id: "w1", text: "la", start: 1, end: 3 },
    { id: "w2", text: "li", start: 4, end: 6 }
  ],
  notes: [
    { id: "n1", wordId: "w1", pitch: 60, start: 1, end: 1.8 },
    { id: "n2", wordId: "w1", pitch: 62, start: 2, end: 3 },
    { id: "n3", wordId: "w2", pitch: 64, start: 4, end: 5 }
  ]
};
const ids = (...values: string[]) => new Set(values);

describe("editor operations", () => {
  it("moves a note without letting it leave its word", () => {
    const moved = moveNotes(document, ids("n1"), 2, 5);
    expect(moved.notes[0]).toMatchObject({ pitch: 62, start: 2.2, end: 3 });
    expect(validateDocument(moved).filter(issue => issue.reason === "outsideWord")).toEqual([]);
  });

  it("moves a multi-selection by the same limited shift", () => {
    const moved = moveNotes(document, ids("n1", "n2"), 0, 5);
    expect(moved.notes[0]?.start).toBe(1);
    expect(moved.notes[1]?.end).toBe(3);
  });

  it("resizes without crossing the opposite edge or a neighbouring note", () => {
    expect(resizeNote(document, "n1", "end", 2.5).notes[0]?.end).toBe(2);
    expect(resizeNote(document, "n2", "start", 0.1).notes[1]?.start).toBe(1.8);
    expect(resizeNote(document, "n3", "end", 4).notes[2]?.end).toBe(4.03);
  });

  it("merges only notes of the same word", () => {
    expect(canMerge(document, ids("n1", "n2"))).toBe(true);
    expect(canMerge(document, ids("n1", "n3"))).toBe(false);
    const merged = mergeNotes(document, ids("n1", "n2"));
    expect(merged.notes).toHaveLength(2);
    expect(merged.notes[0]).toMatchObject({ id: "n1", start: 1, end: 3 });
    expect(mergeNotes(document, ids("n1", "n3"))).toBe(document);
  });

  it("deletes selected notes and aligns boundaries to the playhead", () => {
    expect(deleteNotes(document, ids("n1", "n2")).notes.map(note => note.id)).toEqual(["n3"]);
    expect(alignBoundary(document, ids("n3"), "start", 4.5).notes[2]?.start).toBe(4.5);
  });

  it("snaps to the grid only when enabled", () => {
    expect(snapTime(1.234, true)).toBe(1.25);
    expect(snapTime(1.234, false)).toBe(1.234);
  });

  it("reports notes that break invariants", () => {
    const broken = { ...document, notes: [{ id: "x", wordId: "w1", pitch: 60, start: 0.5, end: 1.4 }] };
    expect(validateDocument(broken)).toEqual([{ noteId: "x", reason: "outsideWord" }]);
  });
});

describe("editor history and dirty state", () => {
  it("undoes and redoes and clears redo after a new edit", () => {
    const first = startHistory(document);
    const second = pushHistory(first, deleteNotes(document, ids("n1")));
    expect(undoHistory(second).present).toBe(document);
    expect(redoHistory(undoHistory(second)).present.notes).toHaveLength(2);
    const branched = pushHistory(undoHistory(second), moveNotes(document, ids("n3"), 1, 0));
    expect(branched.future).toEqual([]);
  });

  it("is dirty by content, so undoing back to the saved state is clean again", () => {
    const changed = deleteNotes(document, ids("n1"));
    expect(isEditorDirty(document, changed)).toBe(true);
    expect(isEditorDirty(document, { ...document, revision: 9 })).toBe(false);
  });
});
