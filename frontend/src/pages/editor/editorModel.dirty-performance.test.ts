import { expect, it } from 'vitest';
import {
  isEditorDirty,
  type EditorDocument,
  type EditorNote,
} from '../../application/editor/editorModel';

const document = (note: EditorNote): EditorDocument => ({
  revision: 1,
  words: [],
  notes: [note],
});
const note: EditorNote = {
  id: 'note',
  wordId: 'word',
  pitch: 60,
  start: 1,
  end: 2,
};

it('does not traverse an unchanged contour to detect pitch or boundary edits', () => {
  let reads = 0;
  const points = Array.from(
    { length: 512 },
    (_, index) => [index / 511, Math.sin(index), 1] as const,
  );
  const contour = new Proxy(points, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  const saved = document({ ...note, contour });
  for (let tick = 1; tick <= 60; tick++) {
    const changed = {
      ...saved,
      notes: [
        {
          ...saved.notes[0]!,
          pitch: 60 + tick,
          start: 1 + tick / 100,
          end: 2 + tick / 100,
        },
      ],
    };
    expect(isEditorDirty(saved, changed)).toBe(true);
  }
  expect(reads).toBe(0);
});

it.each([
  { label: 'unchanged content', lastPitch: 60, dirty: false },
  { label: 'an edit to the last note', lastPitch: 61, dirty: true },
])(
  'does not serialize shared contours of recovered note objects for $label',
  ({ lastPitch, dirty }) => {
    let reads = 0;
    const notes = Array.from({ length: 64 }, (_, index) => ({
      ...note,
      id: `note-${index}`,
      contour: new Proxy(
        Array.from(
          { length: 512 },
          (_, point) => [point / 511, Math.sin(point + index), 1] as const,
        ),
        {
          get(target, key, receiver) {
            if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
            return Reflect.get(target, key, receiver);
          },
        },
      ),
    }));
    const saved = { ...document(note), notes };
    const recovered = {
      ...saved,
      notes: notes.map((item, index) => ({
        ...item,
        id: `restored-${index}`,
        pitch: index === notes.length - 1 ? lastPitch : item.pitch,
      })),
    };

    expect(isEditorDirty(saved, recovered)).toBe(dirty);
    expect(reads).toBe(0);
  },
);

it('preserves content comparison for IDs, contours, words, unknown fields and non-finite numbers', () => {
  const original = {
    ...note,
    contour: [
      [0, 0],
      [1, 1],
    ] as const,
  };
  const saved = document(original);
  expect(
    isEditorDirty(saved, document({ ...original, id: 'replacement' })),
  ).toBe(false);
  expect(
    isEditorDirty(
      saved,
      document({
        ...original,
        contour: [
          [0, 0],
          [1, 1],
        ],
      }),
    ),
  ).toBe(false);
  expect(
    isEditorDirty(
      saved,
      document({
        ...original,
        contour: [
          [0, 0],
          [1, 2],
        ],
      }),
    ),
  ).toBe(true);
  expect(
    isEditorDirty(saved, {
      ...saved,
      words: [{ id: 'word', text: 'Edited', start: 1, end: 2 }],
    }),
  ).toBe(true);
  const extended = { ...original, source: 'edited' };
  expect(isEditorDirty(saved, document(extended))).toBe(true);
  expect(
    isEditorDirty(
      document({ ...original, pitch: Infinity }),
      document({ ...original, pitch: NaN }),
    ),
  ).toBe(false);
  expect(
    isEditorDirty(
      document({ ...original, start: -0 }),
      document({ ...original, start: 0 }),
    ),
  ).toBe(false);
});
