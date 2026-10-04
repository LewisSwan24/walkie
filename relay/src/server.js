// The relay: a blind pipe between a PC and a device that both dial out to it (docs/superpowers/specs/2026-10-03-walkie-stage3-outside-design.md, 5.1).
// wss://<host>/r/<room id>?role=pc|device. A room holds at most one PC and one device, and a second connection of the same role replaces
// the first. Every binary message goes to the peer unchanged, and is dropped when the peer is not there: nothing is parsed or kept.
// The relay never sees a key. It cannot read the frames (they are sealed) and cannot forge one; it can only drop or delay them.
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

export const MAX_MESSAGE = 1100; // the largest frame the link carries (MAX_CHUNK in bridge/src/link/frame.js)
export const CLOSE_REPLACED = 4000;
const PATH = /^\/r\/([0-9a-f]{32})$/;
const PEER = { pc: 'device', device: 'pc' };

const refuse = (socket, status, text) => {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
};

// Resolves with { port, close(), stats() } once it is listening. `trustProxy` reads the client's address from Fly-Client-IP, which is
// what a proxy in front of the relay (Fly's) sets; without it the socket's own address is used.
export async function startRelay({
  port = 0,
  host = '127.0.0.1',
  maxConnections = 64,
  maxPerIp = 8,
  trustProxy = false,
  pingEveryMs = 30_000,
  log = () => {},
} = {}) {
  const rooms = new Map(); // id -> { pc, device }
  const perIp = new Map();
  const stats = { connections: 0, forwarded: 0, dropped: 0, replaced: 0, refused: 0 };

  const http = createServer((req, res) => {
    const ok = req.method === 'GET' && req.url === '/healthz';
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'text/plain' });
    res.end(ok ? 'ok' : 'not found');
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE, perMessageDeflate: false });

  http.on('upgrade', (req, socket, head) => {
    let url = null;
    try {
      url = new URL(req.url, 'http://relay');
    } catch {} // a request line that is no URL at all (GET http://[): refused below, not a crash of the relay
    const match = url && PATH.exec(url.pathname);
    const role = url?.searchParams.get('role');
    if (!match || !PEER[role]) {
      stats.refused++;
      return refuse(socket, 400, 'Bad Request');
    }
    const ip = (trustProxy && req.headers['fly-client-ip']) || req.socket.remoteAddress || '?';
    if (stats.connections >= maxConnections) {
      stats.refused++;
      return refuse(socket, 503, 'Service Unavailable');
    }
    if ((perIp.get(ip) ?? 0) >= maxPerIp) {
      stats.refused++;
      return refuse(socket, 429, 'Too Many Requests');
    }
    // Counted once the handshake is done, not before: ws turns some upgrades down itself (no Sec-WebSocket-Key, a socket already gone)
    // and never calls back, and a slot counted for those would never come back.
    wss.handleUpgrade(req, socket, head, (ws) => join(ws, match[1], role, ip));
  });

  function join(ws, id, role, ip) {
    stats.connections++;
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    const room = rooms.get(id) ?? {};
    rooms.set(id, room);
    if (room[role]) {
      stats.replaced++;
      room[role].close(CLOSE_REPLACED, 'replaced');
    }
    room[role] = ws;
    ws.alive = true;
    ws.on('pong', () => {
      ws.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return ws.close(1003, 'binary frames only');
      const peer = rooms.get(id)?.[PEER[role]];
      if (peer && peer.readyState === peer.OPEN) {
        stats.forwarded++;
        peer.send(data, { binary: true });
      } else {
        stats.dropped++;
      }
    });
    ws.on('error', () => {}); // the close event follows
    ws.on('close', () => {
      stats.connections--;
      const left = (perIp.get(ip) ?? 1) - 1;
      if (left <= 0) perIp.delete(ip);
      else perIp.set(ip, left);
      if (rooms.get(id)?.[role] === ws) delete rooms.get(id)[role];
      const now = rooms.get(id);
      if (now && !now.pc && !now.device) rooms.delete(id);
    });
    log(`${role} joined room ${id.slice(0, 4)}...`); // never the whole id: it is the way in
  }

  // A peer that went away without saying so (a phone leaving Wi-Fi) would hold its place in the room until the TCP timeout.
  const reaper = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
  }, pingEveryMs);
  reaper.unref();

  await new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, host, resolve);
  });

  return {
    port: http.address().port,
    stats: () => ({ ...stats, rooms: rooms.size }),
    close: () =>
      new Promise((resolve) => {
        clearInterval(reaper);
        for (const ws of wss.clients) ws.terminate();
        http.close(() => resolve());
        http.closeAllConnections();
      }),
  };
}
