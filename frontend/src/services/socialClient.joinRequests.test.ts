import { beforeEach, expect, it, vi } from 'vitest';
import { clearStorage } from '../shared/storage/localStore';
import { bridgedHttp } from './desktopBridge';
import { socialClient } from './socialClient';

vi.mock('./desktopBridge', () => ({ bridgedHttp: vi.fn() }));

const pendingRequest = () => {
  let resolve: (value?: unknown) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<unknown>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  clearStorage();
  vi.mocked(bridgedHttp).mockReset();
});

it('recognizes a requested room when host approval arrives before the request response', async () => {
  const response = pendingRequest();
  vi.mocked(bridgedHttp).mockReturnValueOnce(response.promise);
  const requesting = socialClient.requestRoomJoin('host', 'EARLY');

  const requestedAtApproval = socialClient.isRequestedRoom('EARLY');
  response.resolve();
  await requesting;

  expect(requestedAtApproval).toBe(true);
  expect(socialClient.isRequestedRoom('EARLY')).toBe(true);
  expect(socialClient.isRequestedRoom('OTHER')).toBe(false);
});

it('does not restore a consumed request when its delayed response arrives', async () => {
  const response = pendingRequest();
  vi.mocked(bridgedHttp).mockReturnValueOnce(response.promise);
  const requesting = socialClient.requestRoomJoin('host', 'CONSUMED');

  socialClient.clearRequestedRoom('CONSUMED');
  response.resolve();
  await requesting;

  expect(socialClient.isRequestedRoom('CONSUMED')).toBe(false);
});

it('does not remember a failed request as permission for a later invitation', async () => {
  const response = pendingRequest();
  vi.mocked(bridgedHttp).mockReturnValueOnce(response.promise);
  const requesting = socialClient.requestRoomJoin('host', 'FAILED');
  const failed = expect(requesting).rejects.toThrow('Unavailable');
  response.reject(new Error('Unavailable'));
  await failed;

  expect(socialClient.isRequestedRoom('FAILED')).toBe(false);
});

it('keeps an overlapping request active when another attempt fails', async () => {
  const first = pendingRequest();
  const second = pendingRequest();
  vi.mocked(bridgedHttp)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const earlier = socialClient.requestRoomJoin('host', 'OVERLAP');
  const later = socialClient.requestRoomJoin('host', 'OVERLAP');
  const failed = expect(earlier).rejects.toThrow('Unavailable');
  first.reject(new Error('Unavailable'));
  await failed;
  const requestedWhileLaterPending = socialClient.isRequestedRoom('OVERLAP');
  second.resolve();
  await later;

  expect(requestedWhileLaterPending).toBe(true);
  expect(socialClient.isRequestedRoom('OVERLAP')).toBe(true);
});

it('does not let a consumed older response restore or retire a newer request', async () => {
  const first = pendingRequest();
  const second = pendingRequest();
  vi.mocked(bridgedHttp)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const earlier = socialClient.requestRoomJoin('host', 'REPLACED');
  socialClient.clearRequestedRoom('REPLACED');
  const later = socialClient.requestRoomJoin('host', 'REPLACED');
  first.resolve();
  await earlier;
  const requestedWhileLaterPending = socialClient.isRequestedRoom('REPLACED');
  const failed = expect(later).rejects.toThrow('Unavailable');
  second.reject(new Error('Unavailable'));
  await failed;

  expect(requestedWhileLaterPending).toBe(true);
  expect(socialClient.isRequestedRoom('REPLACED')).toBe(false);
});

it('keeps an already confirmed request when a later attempt fails', async () => {
  vi.mocked(bridgedHttp).mockResolvedValueOnce(undefined);
  await socialClient.requestRoomJoin('host', 'CONFIRMED');
  vi.mocked(bridgedHttp).mockRejectedValueOnce(new Error('Unavailable'));

  await expect(
    socialClient.requestRoomJoin('host', 'CONFIRMED'),
  ).rejects.toThrow('Unavailable');

  expect(socialClient.isRequestedRoom('CONFIRMED')).toBe(true);
});
