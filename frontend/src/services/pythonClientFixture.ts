
import { vi } from 'vitest';


type Call = {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
};
const installBridge = (
  reply: (call: Call) => { status: number; ok: boolean; body: unknown },
) => {
  const calls: Call[] = [];
  Object.assign(window, {
    desktop: {
      pythonRequest: vi.fn(async (call: Call) => {
        calls.push(call);
        return reply(call);
      }),
    },
  });
  return calls;
};
const model = {
  modelId: 'speech/model + test',
  purpose: 'ASR',
  version: 'v1/2',
  size: 100,
  requiredDiskBytes: 268435656,
  state: 'Missing',
} as const;
export { installBridge, model };
export type { Call };
