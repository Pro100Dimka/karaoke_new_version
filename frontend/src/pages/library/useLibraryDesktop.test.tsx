import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { libraryCommands } from '../../app/desktop/shellBus';
import { useLibraryDesktop } from './useLibraryDesktop';

const state = vi.hoisted(() => ({
  application: { services: { python: { kind: 'ready' } } },
}));
const imports = vi.hoisted(() => ({
  addSong: vi.fn(),
  importFiles: vi.fn(),
  pathForFile: vi.fn((file: File) => `D:\\Music\\${file.name}`),
}));
vi.mock('../../providers/store', () => ({ store: state }));
vi.mock('./modals/add-song/useLibraryImport', () => ({
  useLibraryImport: () => imports,
}));
vi.mock('../../services/desktopClient', () => ({ desktopClient: imports }));

beforeEach(() => {
  vi.clearAllMocks();
  state.application.services.python.kind = 'ready';
});
afterEach(() => libraryCommands.subscribe(() => undefined)());

const DropSurface = () => {
  const desktop = useLibraryDesktop(vi.fn());
  return (
    <main
      onDragOver={desktop.onDragOver}
      onDragLeave={desktop.onDragLeave}
      onDrop={desktop.onDrop}
    >
      {desktop.dragging && <span>Drop to import</span>}
    </main>
  );
};

it('retains files dropped during a backend interruption and imports them once on recovery', () => {
  const view = render(<DropSurface />);
  state.application.services.python.kind = 'unavailable';
  view.rerender(<DropSurface />);
  const surface = screen.getByRole('main');
  const dataTransfer = { files: [new File(['audio'], 'Пісня.mp3')] };
  fireEvent.dragOver(surface, { dataTransfer });
  expect(screen.getByText('Drop to import')).toBeVisible();
  fireEvent.drop(surface, { dataTransfer });
  expect(screen.queryByText('Drop to import')).toBeNull();
  expect(imports.importFiles).not.toHaveBeenCalled();

  state.application.services.python.kind = 'ready';
  view.rerender(<DropSurface />);
  expect(imports.importFiles).toHaveBeenCalledExactlyOnceWith([
    'D:\\Music\\Пісня.mp3',
  ]);
  view.rerender(<DropSurface />);
  expect(imports.importFiles).toHaveBeenCalledOnce();
});

it('imports dropped files immediately while the backend is ready', () => {
  render(<DropSurface />);
  const files = [
    new File(['first'], 'first.mp3'),
    new File(['second'], 'second.flac'),
  ];
  fireEvent.drop(screen.getByRole('main'), { dataTransfer: { files } });
  expect(imports.importFiles).toHaveBeenCalledExactlyOnceWith([
    'D:\\Music\\first.mp3',
    'D:\\Music\\second.flac',
  ]);
});

it('opens the room dialog for a desktop command without an invitation code', () => {
  const onOpenRoom = vi.fn();
  renderHook(() => useLibraryDesktop(onOpenRoom));
  act(() => libraryCommands.push({ type: 'openRoom' }));
  expect(onOpenRoom).toHaveBeenCalledExactlyOnceWith(undefined);
});

it('retains the invitation code from a desktop join request', () => {
  const onOpenRoom = vi.fn();
  renderHook(() => useLibraryDesktop(onOpenRoom));
  act(() => libraryCommands.push({ type: 'openRoom', code: 'ROOM-123' }));
  expect(onOpenRoom).toHaveBeenCalledExactlyOnceWith('ROOM-123');
});

it('opens a queued room request once the library backend is ready', () => {
  state.application.services.python.kind = 'starting';
  const onOpenRoom = vi.fn();
  const { rerender } = renderHook(() => useLibraryDesktop(onOpenRoom));
  act(() => libraryCommands.push({ type: 'openRoom' }));
  expect(onOpenRoom).not.toHaveBeenCalled();

  state.application.services.python.kind = 'ready';
  rerender();
  expect(onOpenRoom).toHaveBeenCalledExactlyOnceWith(undefined);
});
