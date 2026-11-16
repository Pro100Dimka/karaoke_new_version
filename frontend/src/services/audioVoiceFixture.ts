import { afterEach, beforeEach, vi } from 'vitest';
const installBridge = (
  reply: (
    request: AudioBridgeRequest,
  ) => AudioBridgeResponse | Promise<AudioBridgeResponse> = ({ command }) => ({
    status: 0,
    text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(command)
      ? 'SessionState: Running'
      : 'Ok',
  }),
  desktop: Partial<Omit<DesktopApi, 'audioRequest'>> = {},
) => {
  const requests: AudioBridgeRequest[] = [];
  Object.assign(window, {
    desktop: {
      ...desktop,
      audioRequest: vi.fn(async (request: AudioBridgeRequest) => {
        requests.push(request);
        return reply(request);
      }),
    },
  });
  return requests;
};
beforeEach(() => vi.resetModules());
afterEach(() => Reflect.deleteProperty(window, 'desktop'));
export { installBridge };
