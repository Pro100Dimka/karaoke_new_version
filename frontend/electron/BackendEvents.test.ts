import { expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { BackendEndpoint } from './BackendEndpoint';
import {
  parseServerSentEvents,
  streamBackendEvents,
  type BackendEvent,
} from './BackendEvents';

it('parses complete messages, skips heartbeats and keeps a partial message for the next chunk', () => {
  const job = {
    type: 'job.changed',
    createdAt: 'now',
    data: { jobId: 'j1', state: 'Running' },
  };
  const parsed = parseServerSentEvents(
    `: heartbeat\n\ndata: ${JSON.stringify(job)}\n\ndata: {"type":"job.ch`,
  );
  expect(parsed.events).toEqual([job]);
  expect(parsed.rest).toBe('data: {"type":"job.ch');
  expect(
    parseServerSentEvents(`${parsed.rest}anged","data":{"jobId":"j2"}}\r\n\r\n`)
      .events,
  ).toEqual([{ type: 'job.changed', data: { jobId: 'j2' } }]);
});

it('requests a fresh snapshot after malformed or untyped messages', () => {
  expect(
    parseServerSentEvents('data: not json\n\ndata: {"no":"type"}\n\n').events,
  ).toEqual([{ type: 'resync' }, { type: 'resync' }]);
});

it('reconnects after a real SSE connection closes and requests a fresh snapshot before new events', async () => {
  let connections = 0;
  let first: ServerResponse | undefined;
  const server = createServer((_request, response) => {
    connections += 1;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.flushHeaders();
    if (connections === 1) first = response;
    response.write(
      `data: ${JSON.stringify({
        type: 'job.changed',
        data: { jobId: connections === 1 ? 'old' : 'current' },
      })}\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing test server address');
  const endpoint = new BackendEndpoint();
  endpoint.stdout(Buffer.from(`AD_VOICE_BACKEND_READY:${address.port}\n`));
  const stop = new AbortController();
  const received: BackendEvent[] = [];
  try {
    streamBackendEvents(endpoint, (event) => received.push(event), stop.signal);
    await vi.waitFor(() => expect(received).toHaveLength(2));
    first?.destroy();
    await vi.waitFor(() => expect(received).toHaveLength(4), { timeout: 3000 });
    expect(received).toEqual([
      { type: 'connected' },
      { type: 'job.changed', data: { jobId: 'old' } },
      { type: 'connected' },
      { type: 'job.changed', data: { jobId: 'current' } },
    ]);
  } finally {
    stop.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
