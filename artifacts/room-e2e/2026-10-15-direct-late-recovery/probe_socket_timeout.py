"""Independent Winsock receive-timeout probe; loopback only, no room/audio changes."""
import json
import select
import socket
import struct
import threading
import time


def run(mode, count=400):
    receiver = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    receiver.bind(('127.0.0.1', 0))
    receiver.setsockopt(socket.SOL_SOCKET, socket.SO_RCVTIMEO,
                        struct.pack('I', 2 if mode == 'timeout2' else 100))
    sender = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    seen = []
    errors = {}
    done = threading.Event()

    def receive():
        while not done.is_set():
            if mode == 'select2' and not select.select([receiver], [], [], .002)[0]:
                continue
            try:
                data, _ = receiver.recvfrom(65536)
                seen.append(struct.unpack('<I', data[:4])[0])
            except OSError as error:
                key = str(error.winerror)
                errors[key] = errors.get(key, 0) + 1

    worker = threading.Thread(target=receive)
    worker.start()
    started = time.perf_counter()
    for sequence in range(count):
        target = started + sequence * .0025
        delay = target - time.perf_counter()
        if delay > 0:
            time.sleep(delay)
        sender.sendto(struct.pack('<I', sequence) + b'x' * 240, receiver.getsockname())
    time.sleep(.15)
    done.set()
    worker.join(timeout=1)
    receiver.close()
    sender.close()
    missing = sorted(set(range(count)) - set(seen))
    return dict(mode=mode, sent=count, received=len(set(seen)), missing=missing,
                errors=errors, workerStopped=not worker.is_alive())


if __name__ == '__main__':
    print(json.dumps([run(mode) for mode in ('timeout100', 'timeout2', 'select2')], indent=2))
