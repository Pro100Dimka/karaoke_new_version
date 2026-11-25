import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  beginRoomRecordingSource,
  markSilentRoomSource,
  prepareRoomRecordingSources,
} from './roomRecordingSources';
import { isRecord } from '../shared/storage/localStore';

vi.mock('./roomMappers', () => ({ participantId: 'self' }));
const desktop = {
  pythonRequest: vi.fn(),
  roomRequest: vi.fn(),
  uploadRoomSource: vi.fn(),
  downloadRoomSource: vi.fn(),
  releaseRoomProjectDownload: vi.fn(),
};
const reply = (body: unknown) => ({ ok: true, status: 200, body });
const singerOf = (request: PythonBridgeRequest) =>
  isRecord(request.body) ? request.body.participantId : undefined;

beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(window, { desktop });
  desktop.pythonRequest.mockImplementation(
    async (request: PythonBridgeRequest) => {
      if (request.method === 'GET')
        return reply({
          roomPerformance: { roomId: 'room', performanceId: 7 },
          roomSources: { status: 'pending', participants: {} },
        });
      if (request.path.endsWith('/room-source'))
        return reply({ filePath: 'D:/own.zip' });
      if (request.path.endsWith('/import'))
        return reply({
          directory: singerOf(request) === 'self' ? 'own' : 'remote',
        });
      return reply({});
    },
  );
  desktop.roomRequest.mockResolvedValue(
    reply({
      complete: true,
      participants: [
        {
          participantId: 'self',
          available: true,
          sizeBytes: 100,
          captures: [{ captureId: 'take', available: true, sizeBytes: 100 }],
        },
        {
          participantId: 'other',
          available: true,
          sizeBytes: 100,
          captures: [
            { captureId: 'remote-take', available: true, sizeBytes: 100 },
          ],
        },
        { participantId: 'silent', available: true, sizeBytes: 0 },
      ],
    }),
  );
  desktop.downloadRoomSource.mockResolvedValue('D:/download.zip');
});
afterEach(() => {
  vi.useRealTimers();
  delete window.desktop;
});

it('registers each capture before its audio is available and publishes its silent end separately', async () => {
  await beginRoomRecordingSource(
    { roomId: 'room', performanceId: 7 },
    'capture',
  );
  await markSilentRoomSource({ roomId: 'room', performanceId: 7 }, 'capture');
  expect(
    desktop.roomRequest.mock.calls.map(([request]) => [
      request.method,
      request.path,
    ]),
  ).toEqual([
    ['POST', '/rooms/room/performances/7/sources/self/captures/capture'],
    ['PUT', '/rooms/room/performances/7/sources/self/captures/capture'],
  ]);
});

it('waits for the performance to finish even when current source files are ready', async () => {
  vi.useFakeTimers();
  const completed = desktop.roomRequest.getMockImplementation()!;
  desktop.roomRequest.mockImplementationOnce(async () => {
    const result = await completed();
    return { ...result, body: { ...result.body, complete: false } };
  });
  const collecting = prepareRoomRecordingSources('take');
  await vi.advanceTimersByTimeAsync(0);
  expect(
    desktop.pythonRequest.mock.calls.some(([request]) =>
      request.path.endsWith('/room-sources'),
    ),
  ).toBe(false);
  await vi.advanceTimersByTimeAsync(500);
  await collecting;
  expect(desktop.pythonRequest).toHaveBeenLastCalledWith(
    expect.objectContaining({ path: '/recordings/take/room-sources' }),
  );
});

it('collects every separate singer once and releases imported downloads', async () => {
  const first = prepareRoomRecordingSources('take');
  expect(prepareRoomRecordingSources('take')).toBe(first);
  await first;
  expect(desktop.uploadRoomSource).toHaveBeenCalledOnce();
  expect(desktop.downloadRoomSource).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ sourceParticipantId: 'other', performanceId: 7 }),
  );
  expect(desktop.releaseRoomProjectDownload).toHaveBeenCalledExactlyOnceWith(
    'D:/download.zip',
  );
  expect(desktop.pythonRequest).toHaveBeenLastCalledWith({
    method: 'POST',
    path: '/recordings/take/room-sources',
    body: { participants: { self: ['own'], other: ['remote'], silent: null } },
  });
});

it('releases a rejected source and never marks incomplete inputs ready', async () => {
  const original = desktop.pythonRequest.getMockImplementation()!;
  desktop.pythonRequest.mockImplementation(
    async (request: PythonBridgeRequest) => {
      if (request.path.endsWith('/import') && singerOf(request) === 'other')
        return {
          ok: false,
          status: 409,
          body: { code: 'RoomVocalSourceUnavailable' },
        };
      return original(request);
    },
  );
  await expect(prepareRoomRecordingSources('take')).rejects.toMatchObject({
    code: 'RoomVocalSourceUnavailable',
  });
  expect(desktop.releaseRoomProjectDownload).toHaveBeenCalledExactlyOnceWith(
    'D:/download.zip',
  );
  expect(desktop.pythonRequest).toHaveBeenLastCalledWith(
    expect.objectContaining({
      body: {
        participants: { self: ['own'] },
        failure: 'Room source transfer failed',
      },
    }),
  );
});

it('publishes an explicitly silent singer without uploading an unrelated recording', async () => {
  await markSilentRoomSource({ roomId: 'room', performanceId: 7 });
  expect(desktop.roomRequest).toHaveBeenCalledExactlyOnceWith({
    method: 'PUT',
    path: '/rooms/room/performances/7/sources/self',
    headers: { 'X-Participant-Id': 'self' },
  });
  expect(desktop.uploadRoomSource).not.toHaveBeenCalled();
});
