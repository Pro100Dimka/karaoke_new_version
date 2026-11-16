import { vi } from 'vitest';




const installBridge = (
  reply: (
    request: AudioBridgeRequest,
  ) => AudioBridgeResponse | Promise<AudioBridgeResponse>,
  desktop: Partial<Omit<DesktopApi, 'audioRequest'>> = {},
) => {
  const commands: string[] = [];
  const requests: AudioBridgeRequest[] = [];
  const audioRequest = vi.fn(async (request: AudioBridgeRequest) => {
    commands.push(request.command);
    requests.push(request);
    return reply(request);
  });
  Object.assign(window, { desktop: { ...desktop, audioRequest } });
  return { commands, requests, audioRequest };
};
export { installBridge };
