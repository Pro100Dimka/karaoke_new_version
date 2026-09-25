import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppProvider } from "../../app/AppContext";
import type { EditorDocument } from "../editor/editorModel";
import { KaraokeStage } from "./KaraokeStage";
import { publishSpectrum } from "../../app/backdrop/spectrumEvents";

describe("KaraokeStage", () => {
  it("renders the melody roll with a complete piano keyboard", () => {
    const editorDocument = { revision: 1, lyrics: "", words: [], notes: [{ id: "n", wordId: "w", start: 0, end: 2, pitch: 60 }] } as EditorDocument;
    render(<AppProvider><KaraokeStage songTitle="Song" position={0} playing={false} rate={1} document={editorDocument} layers={{ showLyrics: false, showNotes: true }} vocalRange="auto" /></AppProvider>);
    expect(screen.getByRole("img")).toBeInTheDocument();
    expect(document.querySelector('[data-role="piano-keyboard"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-role="piano-key"]').length).toBeGreaterThanOrEqual(5);
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

    expect(document.querySelector(".livePitch")).toBeNull();
    expect(document.querySelector('[data-role="live-pitch-marker"]')).not.toBeNull();
    await waitFor(() => expect(document.querySelector('[data-note-hit="true"]')).toBeNull());
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

    expect(document.querySelector('[data-role="live-pitch-marker"]')).toBeNull();
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
      await waitFor(() => expect(document.querySelector(".pianoNote")?.getAttribute("style")).toContain("left:"));
    }
    await waitFor(() => expect(document.querySelector('[data-note-hit="true"]')).not.toBeNull());
    expect(onNoteScoreChange).toHaveBeenLastCalledWith({ hitNotes: 1, totalNotes: 1 });
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

    expect(document.querySelector('[data-role="piano-key"][data-active-pitch="true"]')).toHaveTextContent("A4");
    expect(document.querySelector('[data-active-pitch="true"]')?.getAttribute("style")).toContain("#16c96a");
  });

  it("uses the selected theme primary color when the detected key misses the target", () => {
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
    expect(document.querySelector('[data-active-pitch="true"]')?.getAttribute("style")).toContain("var(--ui-primary)");
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

    const words = document.querySelectorAll(".lyricWord");
    expect(words).toHaveLength(2);
    expect(document.querySelector(".current")).toHaveClass("lyricLineReactive");
    expect(words[0]?.parentElement).toBe(words[1]?.parentElement);
    act(() => publishSpectrum({
      bands: [0, 0, 0],
      backingBands: [0.8, 0.7, 0.6, 0.5, 0.4, 0.2, 0.1],
      bass: 0,
      active: true
    }));
    const lyrics = document.querySelector(".lyrics") as HTMLElement;
    expect(Number(lyrics.style.getPropertyValue("--lyric-kick"))).toBeGreaterThan(0);
    expect(Number(lyrics.style.getPropertyValue("--lyric-snare"))).toBeGreaterThan(0);
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
    expect(document.querySelector('[data-role="live-pitch-marker"]')).toHaveClass("livePitchMarkerHit");
  });
});
