import dgram from "node:dgram";

const keyAt = packet => packet.length >= 16 ? packet.readUInt32LE(12) : 0;

const bind = socket => new Promise((resolve, reject) => {
  socket.once("error", reject);
  socket.bind(0, "127.0.0.1", () => { socket.off("error", reject); resolve(socket.address().port); });
});

const send = (socket, packet, endpoint) => new Promise((resolve, reject) => {
  socket.send(packet, endpoint.port, endpoint.address, error => error ? reject(error) : resolve());
});

/** Routes client packets to the Room Server and sends its centrally mixed replies back. */
export async function createRoomServerProxy({ serverHost = "127.0.0.1", serverPort, impair = () => ({ delayMs: 0, dropped: false }) }) {
  const proxy = dgram.createSocket("udp4");
  const clients = new Map();
  const upstreams = new Map();
  const timers = new Set();
  let upstreamPackets = 0;
  let downstreamPackets = 0;
  const routeSamples = { upstream: [], downstream: [] };
  const schedule = (packet, socket, endpoint, direction, key) => {
    const decision = impair(direction, key) ?? { delayMs: 0, dropped: false };
    if (decision.dropped) return;
    routeSamples[direction].push(Math.max(0, decision.delayMs ?? 0));
    const timer = setTimeout(() => {
      timers.delete(timer);
      void send(socket, packet, endpoint).catch(() => {});
    }, Math.max(0, decision.delayMs ?? 0));
    timers.add(timer);
  };
  const getUpstream = async key => {
    let item = upstreams.get(key);
    if (item) return item;
    const socket = dgram.createSocket("udp4");
    const port = await bind(socket);
    item = { socket, port };
    upstreams.set(key, item);
    socket.on("message", packet => {
      const endpoint = clients.get(key);
      if (endpoint) { downstreamPackets += 1; schedule(packet, proxy, endpoint, "downstream", key); }
    });
    return item;
  };
  proxy.on("message", async (packet, source) => {
    const key = keyAt(packet);
    if (!key) return;
    clients.set(key, { address: source.address, port: source.port });
    const upstream = await getUpstream(key);
    upstreamPackets += 1;
    schedule(packet, upstream.socket, { address: serverHost, port: serverPort }, "upstream", key);
  });
  const port = await bind(proxy);
  return {
    port,
    get upstreamPackets() { return upstreamPackets; },
    get downstreamPackets() { return downstreamPackets; },
    routeSamples,
    serverPortFor: key => upstreams.get(key)?.port,
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      await Promise.all([...upstreams.values(), { socket: proxy }].map(({ socket }) =>
        new Promise(resolve => { socket.close(() => resolve()); })));
    }
  };
}
