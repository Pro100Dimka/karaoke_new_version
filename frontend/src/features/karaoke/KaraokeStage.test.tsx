import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppProvider } from "../../app/AppContext";
import type { EditorDocument } from "../editor/editorModel";
import { KaraokeStage } from "./KaraokeStage";

describe("KaraokeStage", () => {
  it("shows live pitch on the roll without awarding a note from one sample", async () => {
    const editorDocument = {
      revision: 1,
      lyrics: "Sing",
      words: [{ id: "w", text: "Sing", start: 0, end: 2 }],
      notes: [{ id: "n", wordId: "w", start: 0, end: 2, pitch: 69 }]
    } as EditorDocument;
    render(
      <AppProvider>
        <KaraokeStage
          songTitle="Song"
          position={1}
          playing={false}
          rate={1}
          document={editorDocument}
          layers={{ showLyrics: true, showNotes: true }}
          vocalRange="auto"
          pitchHz={440}
        />
      </AppProvider>
    );

    expect(document.querySelector(".ad-melody-voice")).not.toBeNull();
    await waitFor(() => expect(document.querySelector(".ad-melody-note[data-hit]")).toBeNull());
  });

  it("does not invent a pitch marker from the target note while the microphone is silent", () => {
    const editorDocument = {
      revision: 1,
      lyrics: "Sing",
      words: [{ id: "w", text: "Sing", start: 0, end: 2 }],
      notes: [{ id: "n", wordId: "w", start: 0, end: 2, pitch: 69 }]
    } as EditorDocument;
    render(
      <AppProvider>
        <KaraokeStage songTitle="Song" position={1} playing={false} rate={1}
          document={editorDocument} layers={{ showLyrics: true, showNotes: true }} vocalRange="auto" />
      </AppProvider>
    );

    expect(document.querySelector(".ad-melody-voice")).toBeNull();
  });

  it("awards a note after accurate singing covers half of its duration", async () => {
    const editorDocument = {
      revision: 1,
      lyrics: "Sing",
      words: [{ id: "w", text: "Sing", start: 0, end: 1 }],
      notes: [{ id: "n", wordId: "w", start: 0, end: 1, pitch: 69 }]
    } as EditorDocument;
    const onNoteScoreChange = vi.fn();
    const stage = (position: number) => (
      <AppProvider>
        <KaraokeStage songTitle="Song" position={position} playing={false} rate={1}
          document={editorDocument} layers={{ showLyrics: true, showNotes: true }} vocalRange="auto" pitchHz={440}
          onNoteScoreChange={onNoteScoreChange} />
      </AppProvider>
    );
    const view = render(stage(0));
    for (let step = 1; step <= 5; step += 1) {
      view.rerender(stage(step / 10));
      await waitFor(() => expect(document.querySelector(".ad-melody-note")?.getAttribute("style")).toContain("left:"));
    }
    await waitFor(() => expect(document.querySelector(".ad-melody-note[data-hit]")).not.toBeNull());
    expect(onNoteScoreChange).toHaveBeenLastCalledWith({
      hitNotes: 1,
      totalNotes: 1,
      rhythmAccuracyPercent: 50,
      noteStabilityPercent: 100,
    });
  });

  it("shows the marker as a hit within a practical one-semitone karaoke tolerance", () => {
    const editorDocument = {
      revision: 1,
      lyrics: "Sing",
      words: [{ id: "w", text: "Sing", start: 0, end: 2 }],
      notes: [{ id: "n", wordId: "w", start: 0, end: 2, pitch: 69 }]
    } as EditorDocument;
    render(
      <AppProvider>
        <KaraokeStage songTitle="Song" position={1} playing={false} rate={1}
          document={editorDocument} layers={{ showLyrics: true, showNotes: true }} vocalRange="auto"
          pitchHz={440 * 2 ** (0.8 / 12)} />
      </AppProvider>
    );
    expect(document.querySelector(".ad-melody-voice")).toHaveAttribute("data-hit");
  });
});
