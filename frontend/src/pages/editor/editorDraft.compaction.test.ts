import { beforeEach, expect, it, vi } from 'vitest';
import type { EditorDocument } from '../../application/editor/editorModel';
import type { SongDto } from '../../contracts/models';
import {
  clearStorage,
  readText,
  storageKey,
  writeText,
} from '../../shared/storage/localStore';
import { createEditorApi } from './editorApi';
import {
  captureDraft,
  clearDraft,
  loadDraft,
  restoreDraft,
  saveDraft,
} from './editorDraft';

const key = `${storageKey('editorDraft')}.song`;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const base: EditorDocument = {
  revision: 7,
  documentFingerprint: 'a'.repeat(64),
  words: [
    {
      id: 'word-0',
      text: 'Voice',
      start: 0,
      end: 4,
      letters: [0, 0.2, 0.4, 0.6, 1],
    },
    { id: 'word-1', text: 'Again', start: 5, end: 8 },
  ],
  notes: [
    {
      id: 'word-0-note-0',
      wordId: 'word-0',
      pitch: 60,
      start: 0,
      end: 1,
      contour: [
        [0, -0.1, 1],
        [1, 0.2, 0.8],
      ],
    },
    {
      id: 'word-0-note-1',
      wordId: 'word-0',
      pitch: 61,
      start: 1.1,
      end: 2,
      contour: [
        [0, 0.3, 0.9],
        [1, -0.2, 1],
      ],
    },
    {
      id: 'word-0-note-2',
      wordId: 'word-0',
      pitch: 62,
      start: 2.1,
      end: 3,
      contour: [
        [0, -0.4, 1],
        [1, 0.5, 0.7],
      ],
    },
    {
      id: 'word-1-note-0',
      wordId: 'word-1',
      pitch: 65,
      start: 5,
      end: 6,
      contour: [
        [0, 0.6, 0.5],
        [1, -0.3, 1],
      ],
    },
  ],
  vocalActivity: [
    [0, 4],
    [5, 8],
  ],
  rhythm: [
    [0, 1],
    [0.5, 0.8],
  ],
};
const changed = (document: EditorDocument): EditorDocument => ({
  ...document,
  notes: document.notes.map((note, index) =>
    index === 0 ? { ...note, pitch: note.pitch + 1 } : note,
  ),
});
const save = (document = changed(base), saved = base) =>
  saveDraft('song', { baseRevision: saved.revision, document }, saved);

beforeEach(() => clearStorage());

it('keeps a large normal autosave below a tenth of the full document without serializing inherited contours', () => {
  const large: EditorDocument = {
    revision: 7,
    documentFingerprint: 'd'.repeat(64),
    words: Array.from({ length: 500 }, (_, index) => ({
      id: `word-${index}`,
      text: 'Voice',
      start: index * 2,
      end: index * 2 + 2,
    })),
    notes: Array.from({ length: 2000 }, (_, index) => ({
      id: `word-${Math.floor(index / 4)}-note-${index % 4}`,
      wordId: `word-${Math.floor(index / 4)}`,
      pitch: 60,
      start: index / 2,
      end: index / 2 + 0.4,
      contour: Array.from(
        { length: 64 },
        (_, point) => [point / 63, Math.sin(point + index), 1] as const,
      ),
    })),
  };
  const document = changed(large);
  const complete = JSON.stringify({ baseRevision: large.revision, document });
  const contour = large.notes[0]!.contour!;
  const serializeContour = vi.fn(() => contour);
  Object.defineProperty(contour, 'toJSON', { value: serializeContour });

  save(document, large);

  const stored = readText(key)!;
  expect(serializeContour).not.toHaveBeenCalled();
  expect(stored.length).toBeLessThan(complete.length / 10);
  expect(JSON.parse(stored)).not.toHaveProperty('document');
  expect(loadDraft('song', large)).toEqual({ baseRevision: 7, document });
});

it('recovers the exact draft after manual save deletes notes, sorts them and the backend loader renumbers IDs', async () => {
  let backendDocument: unknown;
  const api = createEditorApi(async (request) => {
    if (request.method === 'PUT') {
      backendDocument = (request.body as { document: unknown }).document;
      return { revision: 8, documentFingerprint: 'b'.repeat(64) };
    }
    return {
      songId: 'song',
      revision: 8,
      documentFingerprint: 'b'.repeat(64),
      document: copy(backendDocument),
    };
  });
  const beforeSave: EditorDocument = {
    ...base,
    notes: [base.notes[3]!, base.notes[2]!, base.notes[1]!],
  };
  const committed = await api.save(
    {
      id: 'song',
      title: 'Song',
      artist: 'Singer',
      durationSeconds: 10,
    } as SongDto,
    beforeSave,
    base.revision,
  );
  const saved = { ...beforeSave, ...committed };
  const document = changed(saved);
  save(document, saved);
  const beforeRecovery = readText(key)!;
  const reopened = await api.load('song');

  expect(reopened.notes.map((note) => note.id)).toEqual([
    'word-0-note-0',
    'word-0-note-1',
    'word-1-note-0',
  ]);
  expect(reopened.notes[0]!.contour).toEqual(base.notes[1]!.contour);
  const recovered = loadDraft('song', reopened)!;
  expect(recovered).toEqual({ baseRevision: 8, document });

  const contour = reopened.notes[0]!.contour!;
  const serializeContour = vi.fn(() => contour);
  Object.defineProperty(contour, 'toJSON', { value: serializeContour });
  save(recovered.document, reopened);
  expect(serializeContour).not.toHaveBeenCalled();
  expect(readText(key)!.length).toBeLessThanOrEqual(beforeRecovery.length);
  expect(loadDraft('song', reopened)).toEqual({ baseRevision: 8, document });
});

it.each([
  {
    label: 'modified',
    contour: [
      [0, 0.7, 1],
      [1, -0.4, 0.6],
    ],
  },
  { label: 'separately parsed', contour: copy(base.notes[0]!.contour) },
  {
    label: 'two-element tuples',
    contour: [
      [0, 0.1],
      [1, 0.2],
    ],
  },
  { label: 'empty', contour: [] },
  { label: 'removed', contour: undefined },
] satisfies {
  label: string;
  contour: EditorDocument['notes'][number]['contour'];
}[])(
  'retains $label contour data inline instead of substituting the saved contour',
  ({ contour }) => {
    const document = {
      ...base,
      notes: [
        { ...base.notes[0]!, pitch: 66, contour },
        ...base.notes.slice(1),
      ],
    };
    save(document);
    const raw = readText(key)!;
    const persisted = JSON.parse(raw) as {
      changes?: EditorDocument;
      document?: EditorDocument;
    };
    expect(
      (persisted.changes ?? persisted.document)!.notes[0]!.contour,
    ).toEqual(contour);
    expect(loadDraft('song', base)).toEqual(
      copy({ baseRevision: 7, document }),
    );
  },
);

it('retains two-element inherited contours when a later backend read expands their confidence', () => {
  const legacyBase: EditorDocument = {
    ...base,
    notes: [
      {
        ...base.notes[0]!,
        contour: [
          [0, -0.1],
          [1, 0.2],
        ],
      },
    ],
  };
  const document = changed(legacyBase);
  save(document, legacyBase);
  const normalizedBase = {
    ...legacyBase,
    notes: [
      {
        ...legacyBase.notes[0]!,
        contour: [
          [0, -0.1, 1],
          [1, 0.2, 1],
        ] as const,
      },
    ],
  };
  expect(loadDraft('song', normalizedBase)).toEqual({
    baseRevision: 7,
    document,
  });
});

it.each([
  {
    label: 'changed',
    vocalActivity: [[0, 3]] as const,
    rhythm: [[0.2, 0.6]] as const,
  },
  {
    label: 'separately parsed',
    vocalActivity: copy(base.vocalActivity),
    rhythm: copy(base.rhythm),
  },
  { label: 'empty', vocalActivity: [], rhythm: [] },
  { label: 'removed', vocalActivity: undefined, rhythm: undefined },
])('preserves $label activity and rhythm data', ({ vocalActivity, rhythm }) => {
  const document = { ...changed(base), vocalActivity, rhythm };
  save(document);
  const persisted = JSON.parse(readText(key)!) as {
    changes?: EditorDocument;
    document?: EditorDocument;
  };
  const stored = persisted.changes ?? persisted.document;
  expect(stored!.vocalActivity).toEqual(vocalActivity);
  expect(stored!.rhythm).toEqual(rhythm);
  expect(loadDraft('song', base)).toEqual(copy({ baseRevision: 7, document }));
});

it('keeps recovered scalar objects independent and a subsequent autosave compact', () => {
  save();
  const first = loadDraft('song', base)!;
  first.document.notes[0]!.pitch = 90;
  first.document.words[0]!.text = 'Changed in memory';
  const second = loadDraft('song', base)!;
  expect(second.document.notes[0]!.pitch).toBe(61);
  expect(second.document.words[0]!.text).toBe('Voice');
  expect(base.notes[0]!.pitch).toBe(60);
  expect(base.words[0]!.text).toBe('Voice');
  save(second.document);
  expect(JSON.parse(readText(key)!)).toMatchObject({ format: 2 });
  expect(JSON.parse(readText(key)!)).not.toHaveProperty('document');
});

it('does not reconstruct compact data without the exact saved revision and leaves recovery bytes intact', () => {
  save();
  const raw = readText(key);
  expect(loadDraft('song')).toBeNull();
  expect(loadDraft('song', { ...base, revision: 8 })).toBeNull();
  expect(readText(key)).toBe(raw);
  expect(loadDraft('song', base)).toEqual({
    baseRevision: 7,
    document: changed(base),
  });
});

it.each([
  'middle contour',
  'middle activity',
  'middle rhythm',
  'contour mapping',
])(
  'refuses different %s data even when a restored project reuses the song ID and revision',
  (difference) => {
    const saved: EditorDocument = {
      ...base,
      notes: [
        {
          ...base.notes[0]!,
          contour: [
            [0, -0.1, 1],
            [0.5, 0.25, 0.7],
            [1, 0.2, 0.8],
          ],
        },
        ...base.notes.slice(1),
      ],
      vocalActivity: [
        [0, 2],
        [3, 4],
        [5, 8],
      ],
      rhythm: [
        [0, 1],
        [0.5, 0.8],
        [1, 0.6],
      ],
    };
    const document = changed(saved);
    save(document, saved);
    const raw = readText(key)!;
    const replacement = { ...copy(saved), documentFingerprint: 'c'.repeat(64) };
    if (difference === 'middle contour')
      replacement.notes[0]!.contour = [
        [0, -0.1, 1],
        [0.5, 0.75, 0.7],
        [1, 0.2, 0.8],
      ];
    else if (difference === 'middle activity')
      replacement.vocalActivity = [
        [0, 2],
        [3.2, 4],
        [5, 8],
      ];
    else if (difference === 'middle rhythm')
      replacement.rhythm = [
        [0, 1],
        [0.5, 0.2],
        [1, 0.6],
      ];
    else {
      const first = replacement.notes[0]!.contour;
      replacement.notes[0]!.contour = replacement.notes[1]!.contour;
      replacement.notes[1]!.contour = first;
    }

    expect(loadDraft('song', replacement)).toBeNull();
    expect(readText(key)).toBe(raw);
    expect(captureDraft('song', replacement)).toBe(raw);
    expect(loadDraft('song', saved)).toEqual({ baseRevision: 7, document });
  },
);

it('accepts negative zero normalized by the saved JSON while preserving the draft JSON', () => {
  const saved: EditorDocument = {
    ...base,
    notes: [
      {
        ...base.notes[0]!,
        contour: [
          [0, -0, 1],
          [1, 0.2, 1],
        ],
      },
    ],
    vocalActivity: [[-0, 4]],
    rhythm: [[-0, 1]],
  };
  const document = changed(saved);
  save(document, saved);
  const reopened = copy(saved);
  expect(Object.is(reopened.notes[0]!.contour![0]![1], 0)).toBe(true);
  expect(JSON.stringify(loadDraft('song', reopened))).toBe(
    JSON.stringify({ baseRevision: 7, document }),
  );
});

it.each([true, false])(
  'accepts missing and empty saved analysis as equivalent without changing inline draft fields (originally missing: %s)',
  (missing) => {
    const saved: EditorDocument = {
      ...base,
      notes: [
        { ...base.notes[0]!, contour: missing ? undefined : [] },
        { ...base.notes[1]!, contour: missing ? [] : undefined },
        base.notes[2]!,
      ],
      vocalActivity: missing ? undefined : [],
      rhythm: missing ? undefined : [],
    };
    const document = changed(saved);
    save(document, saved);
    const reopened = copy({
      ...saved,
      notes: [
        { ...saved.notes[0]!, contour: missing ? [] : undefined },
        { ...saved.notes[1]!, contour: missing ? undefined : [] },
        saved.notes[2]!,
      ],
      vocalActivity: missing ? [] : undefined,
      rhythm: missing ? [] : undefined,
    });
    expect(loadDraft('song', reopened)).toEqual(
      copy({ baseRevision: 7, document }),
    );
  },
);

it.each(
  [
    [[0, 90, 0]],
    [[0, 0, 90]],
    [[90, 0, 0]],
    [[-1, 0, 0]],
    [[0.5, 0, 0]],
    [
      [0, 0, 0],
      [0, 0, 1],
    ],
    [[0, 0]],
    'not references',
  ].map((contours) => ({ contours })),
)(
  'rejects invalid compact references $contours while preserving their raw bytes',
  ({ contours }) => {
    save();
    const valid = JSON.parse(readText(key)!) as Record<string, unknown>;
    const raw = JSON.stringify({
      ...valid,
      contours,
    });
    writeText(key, raw);
    expect(loadDraft('song', base)).toBeNull();
    expect(captureDraft('song', base)).toBeNull();
    expect(readText(key)).toBe(raw);
  },
);

it.each([
  { label: 'unavailable', savedBase: undefined },
  { label: 'another revision', savedBase: { ...base, revision: 8 } },
])(
  'backs up valid compact bytes when their saved base is $label without reconstructing them',
  ({ savedBase }) => {
    save();
    const original = readText(key)!;
    expect(loadDraft('song', savedBase)).toBeNull();
    const checkpoint = captureDraft('song', savedBase);
    expect(checkpoint).toBe(original);

    const currentBase = { ...base, revision: 9 };
    save(changed(currentBase), currentBase);
    restoreDraft('song', checkpoint!);
    expect(readText(key)).toBe(original);
    expect(loadDraft('song', savedBase)).toBeNull();
    expect(loadDraft('song', base)).toEqual({
      baseRevision: 7,
      document: changed(base),
    });
  },
);

it.each([
  { label: 'missing', documentFingerprint: undefined },
  { label: 'truncated', documentFingerprint: 'a'.repeat(63) },
  { label: 'non-hex', documentFingerprint: 'g'.repeat(64) },
])(
  'keeps a complete recoverable draft when the backend fingerprint is $label',
  ({ documentFingerprint }) => {
    const legacyBase = { ...base, documentFingerprint };
    const document = changed(legacyBase);
    save(document, legacyBase);
    const raw = readText(key)!;
    const expected = JSON.stringify({ baseRevision: 7, document });
    expect(raw).toBe(expected);
    expect(JSON.parse(raw)).toHaveProperty('document');
    expect(JSON.parse(raw)).not.toHaveProperty('format');
    expect(loadDraft('song')).toEqual(copy({ baseRevision: 7, document }));
    expect(captureDraft('song', legacyBase)).toBe(raw);
    save();
    restoreDraft('song', raw);
    expect(readText(key)).toBe(expected);
  },
);

it('loads a legacy full draft without a base and retains separately parsed contour data', () => {
  const draft = { baseRevision: 7, document: changed(base) };
  saveDraft('song', draft);
  expect(loadDraft('song')).toEqual(draft);
  expect(loadDraft('song', base)).toEqual(draft);
});

it('restores the exact previous compact bytes when a preview is cancelled', () => {
  save();
  const before = readText(key)!;
  const checkpoint = captureDraft('song', base)!;
  save({ ...base, notes: base.notes.slice(1) });
  expect(readText(key)).not.toBe(before);
  restoreDraft('song', checkpoint);
  expect(readText(key)).toBe(before);
  expect(loadDraft('song', base)).toEqual({
    baseRevision: 7,
    document: changed(base),
  });
  clearDraft('song');
  expect(loadDraft('song', base)).toBeNull();
});
