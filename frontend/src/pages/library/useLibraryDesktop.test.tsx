import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { libraryCommands } from '../../app/desktop/shellBus';
import { useLibraryDesktop } from './useLibraryDesktop';

const state = vi.hoisted(() => ({
  application: { services: { python: { kind: 'ready' } } },
}));
vi.mock('../../providers/store', () => ({ store: state }));
vi.mock('./modals/add-song/useLibraryImport', () => ({
  useLibraryImport: () => ({ addSong: vi.fn(), importFiles: vi.fn() }),
}));

beforeEach(() => {
  state.application.services.python.kind = 'ready';
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
