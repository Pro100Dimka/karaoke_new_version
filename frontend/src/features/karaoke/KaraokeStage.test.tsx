import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppProvider } from "../../app/AppContext";
import type { EditorDocument } from "../editor/editorModel";
import { KaraokeStage } from "./KaraokeStage";
import { publishSpectrum } from "../../app/backdrop/spectrumEvents";

describe("KaraokeStage", () => {
  it("renders the melody roll with a complete piano keyboard", () => {
    const editorDocument = { revision: 1, lyrics: "", words: [], notes: [{ id: "n", wordId: "w", start: 0, end: 2, pitch: 60 }] } as EditorDocument;
    render(<AppProvider><KaraokeStage songTitle="Song" position={0} playing={false} rate={1} document={editorDocument} layers={{ showLyrics: false, showNotes: true }} vocalRange="auto" /></AppProvider>);
    expect(document.querySelector(".ad-melody-roll")).toHaveAttribute("role", "img");
    expect(document.querySelector(".ad-melody-roll .ad-piano-keyboard")).not.toBeNull();
    expect(document.querySelectorAll(".ad-piano-key").length).toBeGreaterThanOrEqual(5);
  });

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

  it("highlights the piano key currently detected from the singer", () => {
    const editorDocument = {
      revision: 1,
      lyrics: "Sing",
      words: [{ id: "w", text: "Sing", start: 0, end: 2 }],
      notes: [{ id: "n", wordId: "w", start: 0, end: 2, pitch: 69 }]
    } as EditorDocument;
    render(
      <AppProvider>
        <KaraokeStage songTitle="Song" position={1} playing={false} rate={1}
          document={editorDocument} layers={{ showLyrics: true, showNotes: true }} vocalRange="auto" pitchHz={440} />
      </AppProvider>
    );

    expect(document.querySelector(".ad-piano-key[data-active]")).toHaveTextContent("A4");
    expect(document.querySelector(".ad-piano-key[data-active]")).toHaveAttribute("data-hit");
  });

  it("keeps the detected key in the theme colour when it misses the target", () => {
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
          pitchHz={440 * 2 ** (2 / 12)} />
      </AppProvider>
    );
    expect(document.querySelector(".ad-piano-key[data-active]")).not.toHaveAttribute("data-hit");
  });

  it("applies percussion reaction to the whole current lyric line", () => {
    const editorDocument = {
      revision: 1,
      lyrics: "First second",
      words: [
        { id: "a", text: "First", start: 0, end: 1 },
        { id: "b", text: "second", start: 1, end: 2 }
      ],
      notes: []
    } as unknown as EditorDocument;
    render(
      <AppProvider>
        <KaraokeStage
          songTitle="Song"
          position={1.5}
          playing={false}
          rate={1}
          document={editorDocument}
          layers={{ showLyrics: true, showNotes: false }}
          vocalRange="auto"
        />
      </AppProvider>
    );

    const words = document.querySelectorAll(".ad-lyric-word");
    expect(words).toHaveLength(2);
    expect(words[0]?.parentElement).toHaveClass("ad-lyrics-current");
    expect(words[0]?.parentElement).toBe(words[1]?.parentElement);
    act(() => publishSpectrum({
      bands: [0, 0, 0],
      backingBands: [0.8, 0.7, 0.6, 0.5, 0.4, 0.2, 0.1],
      bass: 0,
      active: true
    }));
    const lyrics = document.querySelector(".ad-karaoke-lyrics") as HTMLElement;
    expect(Number(lyrics.style.getPropertyValue("--ad-lyric-kick"))).toBeGreaterThan(0);
    expect(Number(lyrics.style.getPropertyValue("--ad-lyric-snare"))).toBeGreaterThan(0);
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
