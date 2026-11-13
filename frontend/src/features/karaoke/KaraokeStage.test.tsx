import { act, render, screen } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { MelodyRollProps } from '@neo-ui-kit/react';
import type { EditorDocument } from '../../application/editor/editorModel';
import { KaraokeStage } from './KaraokeStage';

const probe = vi.hoisted(() => {
  const props: MelodyRollProps[] = [];
  return { props, mounts: 0, playing: false };
});
vi.mock('@neo-ui-kit/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@neo-ui-kit/react')>()),
  MelodyRoll: (props: MelodyRollProps) => {
    probe.props.push(props);
    useEffect(() => { probe.mounts++; }, []);
    return <div data-testid="roll" />;
  },
}));
vi.mock('../../providers/store', () => ({
  store: { preferences: { reducedMotion: false, headingFont: 'default' } },
}));
vi.mock('./useSmoothPosition', () => ({ useSmoothPosition: (position: number) => position }));
vi.mock('./useLyricFill', () => ({ useLyricFill: () => undefined }));
vi.mock('./usePianoRollLayout', () => ({
  usePianoRollLayout: () => ({ layout: null, active: false }),
}));
vi.mock('../../shared/ui/useDetachedPanel', () => ({
  useDetachedPanel: () => ({ detached: false }),
}));
vi.mock('../../shared/ui/DetachedPanel', () => ({
  DetachedPanel: ({ children }: { children: ReactNode }) => children,
  DetachButton: () => null,
}));
vi.mock('./show/ShowLayers', () => {
  const engine = { hitNoteIds: new Set<string>(), noteScore: undefined };
  return {
    useShowEngine: () => engine,
    StageFx: () => null,
    RollFx: ({ playing }: { playing: boolean }) => { probe.playing = playing; return null; },
  };
});

const document: EditorDocument = {
  revision: 1,
  lyrics: 'one\ntwo\nthree\nfour',
  words: ['one', 'two', 'three', 'four'].map((text, index) => ({
    id: `w${index}`, text, start: 20 + index, end: 20.5 + index,
  })),
  notes: Array.from({ length: 4 }, (_, index) => ({
    id: `n${index}`, wordId: `w${index}`, pitch: 60, start: 20 + index, end: 20.5 + index,
  })),
};
const view = (position: number) => <KaraokeStage
  songTitle="Song" document={document} position={position} playing rate={1}
  layers={{ showNotes: true, showLyrics: true }} vocalRange="auto"
/>;
beforeEach(() => { probe.props.length = 0; probe.mounts = 0; });

it('passes future phrases to the roll before their text becomes current', () => {
  render(view(19));
  expect(probe.props.at(-1)?.notes?.map((note) => note.id)).toEqual(['n0', 'n1', 'n2', 'n3']);
});

it('keeps the roll mounted through empty sections and reveals it at the note window edge', () => {
  const { rerender } = render(view(0));
  const roll = screen.getByTestId('roll');
  const panel = roll.closest('.pianoRoll');
  expect(panel).toHaveAttribute('hidden');
  expect(panel).toHaveAttribute('inert');
  expect(probe.playing).toBe(false);
  rerender(view(14));
  expect(panel).not.toHaveAttribute('hidden');
  expect(probe.playing).toBe(true);
  rerender(view(80));
  expect(panel).toHaveAttribute('hidden');
  expect(probe.playing).toBe(false);
  expect(screen.getByTestId('roll')).toBe(roll);
  expect(probe.mounts).toBe(1);
});

it('uses the selected zoom window to determine when a note enters', () => {
  const { rerender } = render(view(14));
  const panel = screen.getByTestId('roll').closest('.pianoRoll');
  expect(panel).not.toHaveAttribute('hidden');
  act(() => { probe.props.at(-1)?.onWindowChange?.(4); });
  expect(panel).toHaveAttribute('hidden');
  rerender(view(17));
  expect(panel).not.toHaveAttribute('hidden');
});
