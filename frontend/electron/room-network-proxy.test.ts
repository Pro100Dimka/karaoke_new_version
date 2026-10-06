import dgram from "node:dgram";
import { afterEach, describe, expect, it } from "vitest";

const live: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((item) => item.close()));
});
const packetFor = (key: number) => {
  const packet = Buffer.alloc(36);
  packet.writeUInt32LE(0x314f4956, 0);
  packet.writeUInt32LE(key, 12);
  return packet;
};

describe("room server network proxy", () => {
  it("routes each participant through a distinct server-facing socket", async () => {
    const { createRoomServerProxy } = await import("./room-network-proxy.mjs");
    const server = dgram.createSocket("udp4");
    await new Promise<void>((resolve) => server.bind(0, "127.0.0.1", resolve));
    const received: Array<{ message: Buffer; address: dgram.AddressInfo }> = [];
    server.on("message", (message, address) =>
      received.push({ message, address }),
    );
    const proxy = await createRoomServerProxy({
      serverPort: server.address().port,
    });
    live.push(proxy);
    const client = dgram.createSocket("udp4");
    await new Promise<void>((resolve) => client.bind(0, "127.0.0.1", resolve));
    client.send(packetFor(17), proxy.port, "127.0.0.1");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(received).toHaveLength(1);
    expect(received[0].message.readUInt32LE(12)).toBe(17);
    expect(proxy.serverPortFor(17)).toBe(received[0].address.port);
    expect(
      proxy.packetTrace.some(
        (item) =>
          item.direction === "upstream" &&
          item.key === 17 &&
          item.dropped === false,
      ),
    ).toBe(true);
    client.close();
    server.close();
  });
});
