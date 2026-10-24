import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppProvider } from "../../app/AppContext";
import type { EditorDocument } from "../../application/editor/editorModel";
import { KaraokeStage } from "./KaraokeStage";
import { KaraokeHeader } from "./KaraokeHeader";

vi.mock("./useSmoothPosition", () => ({ useSmoothPosition: (position: number) => position }));

describe("KaraokeStage", () => {
  it("does not draw the delayed scalar at the current playhead when capture timestamps are available", () => {
    const document: EditorDocument = { revision: 1, lyrics: "Sing", words: [{ id: "w", text: "Sing", start: 0, end: 1 }],
      notes: [{ id: "n", wordId: "w", start: 0, end: 1, pitch: 69 }] };
    const { container } = render(<AppProvider><KaraokeStage songTitle="Song" position={0.4} playing rate={1}
      document={document} layers={{ showLyrics: true, showNotes: true }} vocalRange="auto" pitchHz={440}
      pitchFrames={[{ epoch: 1, sequence: 1, positionSeconds: 0.25, durationSeconds: 0.04, pitchHz: 440 }]} /></AppProvider>);
    expect(container.querySelector(".ad-melody-voice")).toBeNull();
    expect(container.querySelector(".ad-melody-trail path")).toBeNull();
  });
  it("does not add a recording timer or badge above the karaoke stage", () => {
    const previousHeaderProps = { recordingStatus: { label: "Запись · 0:42", active: true } };
    render(<AppProvider><KaraokeHeader visible={false} consoleToggle={null} onBack={vi.fn()}
      {...previousHeaderProps} /></AppProvider>);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("Запись · 0:42")).toBeNull();
  });
  it("uses delayed capture frames once, rather than scoring the newest scalar at the drawn cursor", async () => {
    const editorDocument: EditorDocument = { revision: 1, lyrics: "Sing", words: [{ id: "w", text: "Sing", start: 0, end: 1 }],
      notes: [{ id: "n", wordId: "w", start: 0, end: 0.1, pitch: 69 }] };
    const onNoteScoreChange = vi.fn();
    const frames = [0.025, 0.075].map((positionSeconds, sequence) => ({ sequence: sequence + 1, epoch: 1,
      positionSeconds, durationSeconds: 0.05, pitchHz: 440 }));
    const stage = (position: number, keyShift = 0) => <AppProvider><KaraokeStage songTitle="Song" position={position} playing rate={1} keyShift={keyShift}
      document={editorDocument} layers={{ showLyrics: true, showNotes: true }} vocalRange="auto"
      pitchHz={220 * 2 ** (3 / 12)} pitchFrames={frames} onNoteScoreChange={onNoteScoreChange} /></AppProvider>;
    const view = render(stage(0.4));
    await waitFor(() => expect(onNoteScoreChange).toHaveBeenLastCalledWith(expect.objectContaining({ hitNotes: 1, totalNotes: 1 })));
    const before = onNoteScoreChange.mock.lastCall?.[0];
    view.rerender(stage(0.5));
    expect(onNoteScoreChange.mock.lastCall?.[0]).toEqual(before);
    view.rerender(stage(0.6, 3));
    expect(onNoteScoreChange.mock.lastCall?.[0]).toEqual(before);
  });
  it("fades lyrics and melody together before clearing them, then fades the next entry in", () => {
    const editorDocument: EditorDocument = {
      revision: 1, lyrics: "First\nNext",
      words: [{ id: "first", text: "First", start: 0, end: 2 }, { id: "next", text: "Next", start: 20, end: 22 }],
      notes: [{ id: "note", wordId: "first", start: 0, end: 2, pitch: 69 }],
    };
    const stage = (position: number) => <AppProvider><KaraokeStage songTitle="Song" position={position}
      playing={false} rate={1} document={editorDocument} layers={{ showLyrics: true, showNotes: true }} vocalRange="auto" /></AppProvider>;
    const view = render(stage(4));
    const opacity = (selector: string) => Number((view.container.querySelector(selector) as HTMLElement).style.opacity || 1);
    expect(opacity(".lyrics")).toBe(1);
    view.rerender(stage(4.65));
    expect(opacity(".lyrics")).toBeCloseTo(0.5);
    expect(opacity(".pianoRoll")).toBeCloseTo(0.5);
    expect(screen.getAllByText("First").length).toBeGreaterThan(0);
    view.rerender(stage(5));
    expect(view.container.querySelector(".pianoRoll")).not.toBeVisible();
    view.rerender(stage(17.225));
    expect(opacity(".lyrics")).toBeCloseTo(0.5);
    expect(opacity(".pianoRoll")).toBeCloseTo(0.5);
    view.rerender(stage(18));
    expect(opacity(".lyrics")).toBe(1);
    // Backward seek restores visibility immediately from the musical position.
    view.rerender(stage(1));
    expect(opacity(".pianoRoll")).toBe(1);
  });
  it("hides distant previews and clears both lyrics and melody after three silent seconds, including the outro", () => {
    const editorDocument: EditorDocument = {
      revision: 1, lyrics: "First\nDistant",
      words: [{ id: "first", text: "First", start: 0, end: 2 }, { id: "next", text: "Distant", start: 20, end: 22 }],
      notes: [{ id: "note", wordId: "first", start: 0, end: 2, pitch: 69 }],
    };
    const stage = (position: number) => <AppProvider><KaraokeStage songTitle="Song" position={position}
      playing={false} rate={1} document={editorDocument} layers={{ showLyrics: true, showNotes: true }} vocalRange="auto" /></AppProvider>;
    const view = render(stage(1));
    expect(screen.getAllByText("First").length).toBeGreaterThan(0);
    expect(screen.queryByText("Distant")).not.toBeInTheDocument();
    view.rerender(stage(4.9));
    expect(view.container.querySelector(".pianoRoll")).toBeVisible();
    view.rerender(stage(5));
    expect(view.container.querySelector(".pianoRoll")).not.toBeVisible();
    expect(screen.queryByText("First")).not.toBeInTheDocument();
    view.rerender(stage(17));
    expect(view.container.querySelector(".pianoRoll")).toHaveStyle({ opacity: "0" });
    view.rerender(stage(17.5));
    expect(view.container.querySelector(".pianoRoll")).toBeVisible();
    expect(screen.getByRole("timer")).toHaveTextContent("3");
    expect(view.container.querySelector(".lyrics .ad-lyric-word")).toBeNull();
    view.rerender(stage(19.4));
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
    expect(screen.getAllByText("Distant").length).toBeGreaterThan(0);
    view.rerender(stage(25));
    expect(view.container.querySelector(".pianoRoll")).not.toBeVisible();
    expect(screen.queryByText("Distant")).not.toBeInTheDocument();
    view.rerender(stage(1));
    expect(view.container.querySelector(".pianoRoll")).toBeVisible();
  });
  it("does not display a pitch target before the saved note starts", () => {
    const editorDocument: EditorDocument = {
      revision: 1,
      lyrics: "Sing",
      words: [{ id: "w", text: "Sing", start: 10, end: 12 }],
      notes: [{ id: "n", wordId: "w", start: 10.4, end: 12, pitch: 69 }],
    };
    // The consonant belongs to the word, but the persisted melody starts only at the voiced vowel.
    const stage = (position: number) => (
      <AppProvider>
        <KaraokeStage
          songTitle="Song"
          position={position}
          playing={false}
          rate={1}
          document={editorDocument}
          layers={{ showLyrics: true, showNotes: true }}
          vocalRange="auto"
          pitchHz={440}
        />
      </AppProvider>
    );
    const view = render(stage(10.2));
    expect(document.querySelector(".ad-melody-note[data-now]")).toBeNull();
    expect(document.querySelector(".ad-melody-voice[data-hit]")).toBeNull();
    view.rerender(stage(10.6));
    expect(document.querySelector(".ad-melody-note[data-now]")).not.toBeNull();
    expect(document.querySelector(".ad-melody-voice[data-hit]")).not.toBeNull();
  });

  it("shows live pitch on the roll without awarding a note from one sample", async () => {
    const editorDocument = {
      revision: 1,
      lyrics: "Sing",
      words: [{ id: "w", text: "Sing", start: 0, end: 2 }],
      notes: [{ id: "n", wordId: "w", start: 0, end: 2, pitch: 69 }],
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
      </AppProvider>,
    );

    expect(document.querySelector(".ad-melody-voice")).not.toBeNull();
    await waitFor(() =>
      expect(document.querySelector(".ad-melody-note[data-hit]")).toBeNull(),
    );
  });

  it("does not invent a pitch marker from the target note while the microphone is silent", () => {
    const editorDocument = {
      revision: 1,
      lyrics: "Sing",
      words: [{ id: "w", text: "Sing", start: 0, end: 2 }],
      notes: [{ id: "n", wordId: "w", start: 0, end: 2, pitch: 69 }],
    } as EditorDocument;
    render(
      <AppProvider>
        <KaraokeStage
          songTitle="Song"
          position={1}
          playing={true}
          rate={1}
          document={editorDocument}
          layers={{ showLyrics: true, showNotes: true }}
          vocalRange="auto"
        />
      </AppProvider>,
    );

    expect(document.querySelector(".ad-melody-voice")).toBeNull();
  });

  it("awards a note after accurate singing covers half of its duration", async () => {
    const editorDocument = {
      revision: 1,
      lyrics: "Sing",
      words: [{ id: "w", text: "Sing", start: 0, end: 1 }],
      notes: [{ id: "n", wordId: "w", start: 0, end: 1, pitch: 69 }],
    } as EditorDocument;
    const onNoteScoreChange = vi.fn();
    const stage = (position: number) => (
      <AppProvider>
        <KaraokeStage
          songTitle="Song"
          position={position}
          playing={true}
          rate={1}
          document={editorDocument}
          layers={{ showLyrics: true, showNotes: true }}
          vocalRange="auto"
          pitchHz={440}
          onNoteScoreChange={onNoteScoreChange}
        />
      </AppProvider>
    );
    const view = render(stage(0));
    for (let step = 1; step <= 5; step += 1) {
      view.rerender(stage(step / 10));
      await waitFor(() =>
        expect(
          document.querySelector(".ad-melody-note")?.getAttribute("style"),
        ).toContain("left:"),
      );
    }
    await waitFor(() =>
      expect(
        document.querySelector(".ad-melody-note[data-hit]"),
      ).not.toBeNull(),
    );
    expect(onNoteScoreChange).toHaveBeenLastCalledWith(expect.objectContaining({
      hitNotes: 1,
      totalNotes: 1,
      rhythmAccuracyPercent: 100,
      noteStabilityPercent: 100,
    }));
  });

  it("shows the marker as a hit within a practical one-semitone karaoke tolerance", () => {
    const editorDocument = {
      revision: 1,
      lyrics: "Sing",
      words: [{ id: "w", text: "Sing", start: 0, end: 2 }],
      notes: [{ id: "n", wordId: "w", start: 0, end: 2, pitch: 69 }],
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
          pitchHz={440 * 2 ** (0.8 / 12)}
        />
      </AppProvider>,
    );
    expect(document.querySelector(".ad-melody-voice")).toHaveAttribute(
      "data-hit",
    );
  });
});
