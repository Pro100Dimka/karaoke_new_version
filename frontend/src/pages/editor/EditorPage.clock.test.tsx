import { setLocale, tr, type PianoRollProps } from '@neo-ui-kit/react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { EditorDocument } from '../../application/editor/editorModel';
import type { PlaybackSnapshot, SongDto } from '../../contracts/models';
import { audioClient } from '../../services/audioClient';
import { pythonClient } from '../../services/pythonClient';
import { clearStorage } from '../../shared/storage/localStore';
import '../../providers/localization';
import { editorApi } from './editorApi';
import { EditorPage } from './index';

const probe = vi.hoisted(() => ({ rollRenders: 0 }));
vi.mock('@neo-ui-kit/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@neo-ui-kit/react')>();
  return {
    ...actual,
    useRouter: () => ({ params: { songId: 'song' }, navigate: vi.fn() }),
    PianoRoll: (props: PianoRollProps) => {
      probe.rollRenders++;
      return <actual.PianoRoll {...props} />;
    },
  };
});
vi.mock('../../app/TitleBar', () => ({
  titleBarLeadingId: 'editor-test-header',
}));
vi.mock('../../providers/close-guards', () => ({ useCloseGuard: vi.fn() }));
vi.mock('../../providers/dialog', () => ({ ask: vi.fn() }));
vi.mock('../../providers/notifications', () => ({ useNotify: () => vi.fn() }));
vi.mock('../../services/pythonClient', () => ({
  pythonClient: { getSong: vi.fn(), projectCompatibility: vi.fn() },
}));
vi.mock('../../services/audioClient', () => ({
  audioClient: {
    prepareSong: vi.fn(),
    stop: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    observeSnapshots: vi.fn(),
  },
}));
vi.mock('./editorApi', () => ({ editorApi: { load: vi.fn(), save: vi.fn() } }));
vi.mock('./EditorTransport', () => ({
  EditorTransport: ({ onTogglePlay }: { onTogglePlay(): void }) => (
    <button onClick={onTogglePlay}>Preview test</button>
  ),
}));

const song: SongDto = {
  id: 'song',
  title: 'Song',
  artist: 'Singer',
  status: 'ready',
  activeRevision: 1,
  language: 'English',
  durationSeconds: 10,
  createdAt: '2026-11-20',
  coverState: 'Fallback',
  projectFormatVersion: 1,
};
const document: EditorDocument = {
  revision: 1,
  words: [
    { id: 'w1', text: 'First', start: 1, end: 2 },
    { id: 'w2', text: 'Second', start: 7, end: 8 },
  ],
  notes: [
    { id: 'n1', wordId: 'w1', pitch: 60, start: 1, end: 2 },
    { id: 'n2', wordId: 'w2', pitch: 64, start: 7, end: 8 },
  ],
};
const snapshot: PlaybackSnapshot = {
  sessionId: 'editor-session',
  state: 'ready',
  positionSeconds: 0,
  durationSeconds: 10,
  monitoring: false,
  inputLevel: 0,
};
let publish: (value: PlaybackSnapshot) => void;
let unsubscribe = vi.fn(() => undefined);

beforeEach(() => {
  vi.resetAllMocks();
  probe.rollRenders = 0;
  clearStorage();
  setLocale('ru');
  vi.mocked(pythonClient.getSong).mockResolvedValue(song);
  vi.mocked(pythonClient.projectCompatibility).mockResolvedValue('Current');
  vi.mocked(editorApi.load).mockResolvedValue(document);
  for (const operation of ['prepareSong', 'stop', 'play', 'pause'] as const)
    vi.mocked(audioClient[operation]).mockResolvedValue(snapshot);
  unsubscribe = vi.fn(() => undefined);
  vi.mocked(audioClient.observeSnapshots).mockImplementation((listener) => {
    publish = listener;
    return unsubscribe;
  });
});

const openPlaying = async () => {
  const view = render(<EditorPage />);
  await screen.findByText('First');
  await waitFor(() => expect(audioClient.prepareSong).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('button', { name: 'Preview test' }));
  await waitFor(() =>
    expect(audioClient.observeSnapshots).toHaveBeenCalledOnce(),
  );
  return view;
};
const position = (seconds: number) =>
  act(() =>
    publish({ ...snapshot, state: 'playing', positionSeconds: seconds }),
  );

it('moves the editor clock and highlights without rebuilding the note tree', async () => {
  const view = await openPlaying();
  const renders = probe.rollRenders;
  const notes = view.container.querySelectorAll('.ad-piano-roll-note');
  const first = screen.getByText('First');
  const second = screen.getByText('Second');
  position(1.5);
  expect(notes[0]).toHaveAttribute('data-now');
  expect(notes[1]).not.toHaveAttribute('data-now');
  expect(first).toHaveAttribute('data-now');
  position(7.5);
  expect(notes[0]).not.toHaveAttribute('data-now');
  expect(notes[1]).toHaveAttribute('data-now');
  expect(first).toHaveAttribute('data-sung');
  expect(second).toHaveAttribute('data-now');
  position(0.5);
  expect(first).not.toHaveAttribute('data-sung');
  expect(second).not.toHaveAttribute('data-now');
  for (let frame = 1; frame <= 60; frame++) position(0.5 + frame / 60);
  expect(notes[0]).toHaveAttribute('data-now');
  expect(probe.rollRenders).toBe(renders);
  const head = view.container.querySelector<HTMLElement>(
    '.ad-piano-roll-playhead',
  )!;
  const marker = view.container.querySelector<HTMLElement>(
    '.ad-piano-roll-head-mark',
  )!;
  expect(head.style.left).toBe('calc(var(--ad-pps) * 1.5)');
  expect(marker.style.left).toBe(head.style.left);
  view.unmount();
  position(7.5);
  expect(head.style.left).toBe('calc(var(--ad-pps) * 1.5)');
  await waitFor(() =>
    expect(unsubscribe).toHaveBeenCalledTimes(
      vi.mocked(audioClient.observeSnapshots).mock.calls.length,
    ),
  );
});

it('preserves follow, manual scrolling, zoom and paused highlighting', async () => {
  const view = await openPlaying();
  const scroll = view.container.querySelector<HTMLElement>(
    '.ad-piano-roll-scroll',
  )!;
  const world = view.container.querySelector<HTMLElement>(
    '.ad-piano-roll-world',
  )!;
  vi.spyOn(world, 'offsetWidth', 'get').mockReturnValue(1000);
  vi.spyOn(scroll, 'clientWidth', 'get').mockReturnValue(200);
  position(5);
  expect(scroll.scrollLeft).toBe(440);
  scroll.scrollLeft = 480;
  position(5.1);
  expect(scroll.scrollLeft).toBe(480);
  fireEvent.click(screen.getByRole('button', { name: tr('editorFollow') }));
  scroll.scrollLeft = 0;
  position(7.5);
  expect(scroll.scrollLeft).toBe(0);
  fireEvent.click(screen.getByRole('button', { name: tr('editorFollow') }));
  expect(scroll.scrollLeft).toBe(690);
  vi.spyOn(world, 'offsetWidth', 'get').mockReturnValue(1500);
  fireEvent.click(screen.getByRole('button', { name: tr('zoomIn') }));
  expect(scroll.scrollLeft).toBe(1065);
  fireEvent.click(screen.getByRole('button', { name: 'Preview test' }));
  await waitFor(() => expect(audioClient.pause).toHaveBeenCalledOnce());
  expect(screen.getByText('Second')).toHaveAttribute('data-now');
  await waitFor(() =>
    expect(unsubscribe).toHaveBeenCalledTimes(
      vi.mocked(audioClient.observeSnapshots).mock.calls.length,
    ),
  );
});
