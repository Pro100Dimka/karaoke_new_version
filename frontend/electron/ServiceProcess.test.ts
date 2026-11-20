import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const processMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  ...processMocks,
  default: processMocks,
}));

import { restartBackoff, restartDelay, ServiceProcess } from './ServiceProcess';

const childProcess = (pid: number) =>
  Object.assign(new EventEmitter(), {
    pid,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
    stdin: { end: vi.fn() },
  });
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;

describe('service process lifecycle', () => {
  it('reports the exit code and signal of an unexpected child exit before restarting', async () => {
    const child = childProcess(509);
    processMocks.spawn.mockReturnValue(child);
    const observer = { exited: vi.fn() };
    const service = new ServiceProcess(
      'AudioService.exe',
      [],
      'D:/app',
      {},
      observer,
    );
    service.start();
    child.emit('exit', 3221225477, null);
    expect(observer.exited).toHaveBeenCalledWith(3221225477, null);
    await service.stop();
  });
  it('forwards stderr only from the current child to its observer', async () => {
    const old = childProcess(510);
    const current = childProcess(511);
    processMocks.spawn.mockReturnValueOnce(old).mockReturnValueOnce(current);
    const observer = { stderr: vi.fn() };
    const service = new ServiceProcess(
      'AudioService.exe',
      [],
      'D:/app',
      {},
      observer,
    );
    service.start();
    old.stderr.emit('data', Buffer.from('first error\n'));
    old.emit('exit', 1);
    await vi.advanceTimersByTimeAsync(500);
    old.stderr.emit('data', Buffer.from('stale error\n'));
    current.stderr.emit('data', Buffer.from('current error\n'));
    expect(observer.stderr.mock.calls).toEqual([
      [Buffer.from('first error\n')],
      [Buffer.from('current error\n')],
    ]);
    await service.stop();
  });

  it('reports a failed service launch to the stderr observer once', async () => {
    const child = childProcess(512);
    processMocks.spawn.mockReturnValue(child);
    const observer = { stderr: vi.fn() };
    const service = new ServiceProcess(
      'AudioService.exe',
      [],
      'D:/app',
      {},
      observer,
    );
    service.start();
    child.emit('error', new Error('missing executable'));
    child.emit('exit', 1);
    expect(observer.stderr.mock.calls).toEqual([
      [
        Buffer.from(
          'Service failed to start: AudioService.exe: missing executable\n',
        ),
      ],
    ]);
    await service.stop();
  });

  it('invalidates stopped endpoints and ignores output from previous children', async () => {
    const old = childProcess(500);
    const current = childProcess(501);
    processMocks.spawn.mockReturnValueOnce(old).mockReturnValueOnce(current);
    const observer = { started: vi.fn(), stdout: vi.fn(), stopped: vi.fn() };
    const service = new ServiceProcess(
      'service.exe',
      [],
      'D:/app',
      {},
      observer,
    );
    service.start();
    expect(observer.started).toHaveBeenCalledOnce();
    old.emit('exit', 1);
    expect(observer.stopped).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    old.stdout.emit('data', Buffer.from('stale'));
    current.stdout.emit('data', Buffer.from('current'));
    expect(observer.stdout.mock.calls).toEqual([[Buffer.from('current')]]);
    await service.stop();
    expect(observer.stopped).toHaveBeenCalledTimes(2);
  });
  it('waits for a graceful shutdown to exit without forcing or restarting the child', async () => {
    const child = childProcess(404);
    processMocks.spawn.mockReturnValue(child);
    const service = new ServiceProcess('service.exe', [], 'D:/app');
    service.start();
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const stopping = service.stop(shutdown);
    await Promise.resolve();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(processMocks.spawnSync).not.toHaveBeenCalled();
    child.emit('exit', 0);
    await stopping;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(processMocks.spawn).toHaveBeenCalledOnce();
    expect(processMocks.spawnSync).not.toHaveBeenCalled();
  });
  it('bounds a stuck shutdown and shares repeated graceful stop requests', async () => {
    const child = childProcess(405);
    processMocks.spawn.mockReturnValue(child);
    const service = new ServiceProcess('service.exe', [], 'D:/app');
    service.start();
    const shutdown = vi.fn(() => new Promise<void>(() => {}));
    const stopping = service.stop(shutdown);
    expect(service.stop(shutdown)).toBe(stopping);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(processMocks.spawnSync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(processMocks.spawnSync).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'linux' });
    processMocks.spawn.mockReset();
    processMocks.spawnSync.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(process, 'platform', platform);
  });

  it('coalesces error and exit into one pending restart', () => {
    const child = childProcess(101);
    processMocks.spawn.mockReturnValue(child);
    const service = new ServiceProcess('service.exe', [], 'D:/app');

    service.start();
    child.emit('error', new Error('failed'));
    child.emit('exit', 1);

    expect(vi.getTimerCount()).toBe(1);
  });

  it('cancels a pending restart when the application stops', () => {
    const child = childProcess(202);
    processMocks.spawn.mockReturnValue(child);
    const service = new ServiceProcess('service.exe', [], 'D:/app');

    service.start();
    child.emit('exit', 1);
    service.stop();

    expect(vi.getTimerCount()).toBe(0);
    expect(processMocks.spawnSync).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(processMocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('kills only the owned service handle on non-Windows platforms', () => {
    const child = childProcess(303);
    processMocks.spawn.mockReturnValue(child);
    const service = new ServiceProcess('service.exe', [], 'D:/app');

    service.start();
    service.stop();

    expect(child.kill).toHaveBeenCalledOnce();
    expect(processMocks.spawn).toHaveBeenCalledOnce();
    expect(processMocks.spawnSync).not.toHaveBeenCalled();
  });

  describe('asynchronous Windows process-tree shutdown', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
    });

    it('keeps the event loop responsive and waits for the tree killer before completing stop', async () => {
      const child = childProcess(1001);
      const killer = childProcess(1002);
      processMocks.spawn.mockReturnValueOnce(child).mockReturnValueOnce(killer);
      const service = new ServiceProcess('python.exe', [], 'D:/app');
      service.start();
      const stopping = service.stop();
      let finished = false;
      void stopping.then(() => {
        finished = true;
      });
      expect(processMocks.spawnSync).not.toHaveBeenCalled();
      expect(processMocks.spawn).toHaveBeenLastCalledWith(
        'taskkill',
        ['/pid', '1001', '/T', '/F'],
        { windowsHide: true, stdio: 'ignore' },
      );
      expect(service.stop()).toBe(stopping);
      expect(service.stop(() => Promise.resolve())).toBe(stopping);
      const uiTick = vi.fn();
      setTimeout(uiTick, 25);
      await vi.advanceTimersByTimeAsync(25);
      expect(uiTick).toHaveBeenCalledOnce();
      expect(finished).toBe(false);
      child.emit('exit', 0);
      await Promise.resolve();
      expect(finished).toBe(false);
      killer.emit('close', 0);
      await stopping;
      expect(child.kill).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      service.start();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(processMocks.spawn).toHaveBeenCalledTimes(2);
    });

    it('preserves the graceful deadline and does not resolve on launcher exit during forced termination', async () => {
      const child = childProcess(1101);
      const killer = childProcess(1102);
      processMocks.spawn.mockReturnValueOnce(child).mockReturnValueOnce(killer);
      const service = new ServiceProcess('python.exe', [], 'D:/app');
      service.start();
      const shutdown = vi.fn(() => new Promise<void>(() => {}));
      const stopping = service.stop(shutdown);
      let finished = false;
      void stopping.then(() => {
        finished = true;
      });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(processMocks.spawn).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(processMocks.spawnSync).not.toHaveBeenCalled();
      expect(processMocks.spawn).toHaveBeenCalledTimes(2);
      expect(service.stop()).toBe(stopping);
      child.emit('exit', 0);
      await Promise.resolve();
      expect(finished).toBe(false);
      killer.emit('close', 0);
      await stopping;
      expect(shutdown).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('forces a rejected graceful request without publishing a completed stop early', async () => {
      const child = childProcess(1151);
      const killer = childProcess(1152);
      processMocks.spawn.mockReturnValueOnce(child).mockReturnValueOnce(killer);
      const service = new ServiceProcess('python.exe', [], 'D:/app');
      service.start();
      const stopping = service.stop(() => Promise.reject(new Error('offline')));
      let finished = false;
      void stopping.then(() => {
        finished = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(processMocks.spawn).toHaveBeenCalledTimes(2);
      expect(service.stop()).toBe(stopping);
      expect(finished).toBe(false);
      killer.emit('close', 0);
      await stopping;
      expect(child.kill).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['error', 'nonzero', 'throw', 'timeout'] as const)(
      'falls back to the owned child and clears timers when taskkill fails with %s',
      async (failure) => {
        const child = childProcess(1201);
        const killer = childProcess(1202);
        processMocks.spawn
          .mockReturnValueOnce(child)
          .mockImplementationOnce(() => {
            if (failure === 'throw') throw new Error('taskkill unavailable');
            return killer;
          });
        const service = new ServiceProcess('python.exe', [], 'D:/app');
        service.start();
        const stopping = service.stop();
        expect(processMocks.spawnSync).not.toHaveBeenCalled();
        if (failure === 'error')
          killer.emit('error', new Error('taskkill unavailable'));
        if (failure === 'nonzero') killer.emit('close', 1);
        if (failure === 'timeout') {
          await vi.advanceTimersByTimeAsync(4_999);
          expect(child.kill).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1);
          expect(killer.kill).toHaveBeenCalledOnce();
        }
        await stopping;
        expect(child.kill).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
        if (failure === 'timeout')
          killer.emit('error', new Error('late helper error'));
        killer.emit('close', 1);
        expect(child.kill).toHaveBeenCalledOnce();
        child.emit('exit', 0);
        service.start();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(processMocks.spawn).toHaveBeenCalledTimes(2);
      },
    );

    it('still bounds shutdown if both helper and service handles reject termination', async () => {
      const child = childProcess(1301);
      const killer = childProcess(1302);
      child.kill.mockImplementation(() => {
        throw new Error('already exited');
      });
      killer.kill.mockImplementation(() => {
        throw new Error('access denied');
      });
      processMocks.spawn.mockReturnValueOnce(child).mockReturnValueOnce(killer);
      const service = new ServiceProcess('python.exe', [], 'D:/app');
      service.start();
      const stopping = service.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      await stopping;
      expect(child.kill).toHaveBeenCalledOnce();
      expect(killer.kill).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('crash restart backoff', () => {
    /** A service whose every child dies as soon as it starts; returns how often it was launched. */
    const crashLoop = () => {
      processMocks.spawn.mockImplementation(() => {
        const child = childProcess(700 + processMocks.spawn.mock.calls.length);
        queueMicrotask(() => child.emit('exit', 1));
        return child;
      });
      const service = new ServiceProcess('AudioService.exe', [], 'D:/app');
      service.start();
      return { service, launches: () => processMocks.spawn.mock.calls.length };
    };

    it('waits longer after every crash in a row', async () => {
      const { service, launches } = crashLoop();
      await vi.advanceTimersByTimeAsync(0);
      for (const [index, delay] of [
        500, 1_000, 2_000, 4_000, 8_000,
      ].entries()) {
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(launches()).toBe(index + 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(launches()).toBe(index + 2);
      }
      await service.stop();
    });

    it('never waits longer than its cap', () => {
      expect(restartDelay(0)).toBe(restartBackoff.initialMilliseconds);
      expect(restartDelay(5)).toBe(16_000);
      expect(restartDelay(6)).toBe(restartBackoff.maximumMilliseconds);
      expect(restartDelay(1_000)).toBe(restartBackoff.maximumMilliseconds);
    });

    it('forgives earlier crashes only after a minute of stable running', async () => {
      const children = [
        childProcess(801),
        childProcess(802),
        childProcess(803),
        childProcess(804),
      ] as const;
      processMocks.spawn.mockImplementation(
        () => children[processMocks.spawn.mock.calls.length - 1],
      );
      const service = new ServiceProcess('AudioService.exe', [], 'D:/app');
      service.start();
      children[0].emit('exit', 1);
      await vi.advanceTimersByTimeAsync(500);
      children[1].emit('exit', 1); // crashed again right after its start
      await vi.advanceTimersByTimeAsync(999);
      expect(processMocks.spawn).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(processMocks.spawn).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(restartBackoff.stableMilliseconds);
      children[2].emit('exit', 1); // a crash after a stable minute starts the backoff over
      await vi.advanceTimersByTimeAsync(500);
      expect(processMocks.spawn).toHaveBeenCalledTimes(4);
      await service.stop();
    });

    it("does not count the application's own shutdown as a crash", async () => {
      const child = childProcess(901);
      processMocks.spawn.mockReturnValue(child);
      const service = new ServiceProcess('AudioService.exe', [], 'D:/app');
      service.start();
      await service.stop();
      child.emit('exit', 0);
      await vi.advanceTimersByTimeAsync(restartBackoff.maximumMilliseconds);
      expect(processMocks.spawn).toHaveBeenCalledOnce();
    });

    it("gives a freshly started service no penalty from an earlier one's crashes", async () => {
      const { service: crashed } = crashLoop();
      await vi.advanceTimersByTimeAsync(10_000);
      await crashed.stop();
      processMocks.spawn.mockReset();
      const child = childProcess(990);
      const next = childProcess(991);
      processMocks.spawn.mockReturnValueOnce(child).mockReturnValueOnce(next);
      const restarted = new ServiceProcess('AudioService.exe', [], 'D:/app');
      restarted.start();
      child.emit('exit', 1);
      await vi.advanceTimersByTimeAsync(restartBackoff.initialMilliseconds);
      expect(processMocks.spawn).toHaveBeenCalledTimes(2);
      await restarted.stop();
    });
  });
});
