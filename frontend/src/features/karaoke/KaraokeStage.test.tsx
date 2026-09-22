import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppProvider } from "../../app/AppContext";
import type { EditorDocument } from "../editor/editorModel";
import { KaraokeStage } from "./KaraokeStage";

describe("KaraokeStage", () => {
  it("renders the melody roll with a complete piano keyboard", () => {
    const editorDocument = { revision: 1, lyrics: "", words: [], notes: [{ id: "n", wordId: "w", start: 0, end: 2, pitch: 60 }] } as EditorDocument;
    render(<AppProvider><KaraokeStage songTitle="Song" position={0} playing={false} rate={1} document={editorDocument} layers={{ showLyrics: false, showNotes: true }} vocalRange="auto" /></AppProvider>);
    expect(screen.getByRole("img")).toBeInTheDocument();
    expect(document.querySelector('[data-role="piano-keyboard"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-role="piano-key"]').length).toBeGreaterThanOrEqual(5);
  });
});
