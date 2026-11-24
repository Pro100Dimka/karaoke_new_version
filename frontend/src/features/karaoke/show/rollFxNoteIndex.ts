import type { ShowNote } from './performanceScoring';

interface NoteBlock {
  start: number;
  lastStart: number;
  end: number;
  notes: readonly ShowNote[];
}

/** The roll receives immutable note arrays, including source order and overlaps. */
export class RollFxNoteIndex {
  private readonly blocks: NoteBlock[] = [];
  private readonly ids = new Map<string, number[]>();

  constructor(readonly source: readonly ShowNote[]) {
    for (let first = 0; first < source.length; first += 128) {
      const notes = source.slice(first, first + 128);
      let start = Infinity;
      let lastStart = -Infinity;
      let end = -Infinity;
      notes.forEach((note, offset) => {
        start = Math.min(start, note.start);
        lastStart = Math.max(lastStart, note.start);
        end = Math.max(end, note.end);
        const indices = this.ids.get(note.id);
        if (indices) indices.push(first + offset);
        else this.ids.set(note.id, [first + offset]);
      });
      this.blocks.push({ start, lastStart, end, notes });
    }
  }

  overlapping(start: number, end: number): readonly ShowNote[] {
    const selected: ShowNote[] = [];
    for (const block of this.blocks) {
      if (block.start > end || block.end < start) continue;
      for (const note of block.notes)
        if (note.start <= end && note.end >= start) selected.push(note);
    }
    return selected;
  }

  starting(start: number, end: number): readonly ShowNote[] {
    const selected: ShowNote[] = [];
    for (const block of this.blocks) {
      if (block.start > end || block.lastStart < start) continue;
      for (const note of block.notes) {
        const at = note.start;
        if (at >= start && at <= end) selected.push(note);
      }
    }
    return selected;
  }

  matchingIds(ids: Iterable<string>): readonly ShowNote[] {
    const indices: number[] = [];
    for (const id of ids) {
      const matches = this.ids.get(id);
      if (matches) indices.push(...matches);
    }
    indices.sort((a, b) => a - b);
    return indices.map((index) => this.source[index]!);
  }

  first(id: string): ShowNote | undefined {
    const index = this.ids.get(id)?.[0];
    return index === undefined ? undefined : this.source[index];
  }
}
