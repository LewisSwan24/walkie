// The relay as a port. The Link writes and reads COBS-framed bytes, as it does on USB; across the relay each frame is one
// WebSocket binary message holding the raw envelope (protocol/frames.md, "Relay"). This file converts between the two, so
// the Link does not know which carrier it is on.
import { EventEmitter } from 'node:events';
import { cobsDecode, cobsEncode } from './cobs.js';

export const CLOSE_REPLACED = 4000;
// The slower clock of a network: a phone's hotspot stalls for seconds without being gone.
export const RELAY_PING_EVERY_MS = 5000;
export const RELAY_PONG_TIMEOUT_MS = 10_000;
const ENVELOPE_MIN = 8;
const ENVELOPE_MAX = 8 + 1024;

const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
const HOST = `${LABEL}(?:\\.${LABEL})*(?::\\d{1,5})?`;
const SECURE = new RegExp(`^(?:wss://)?(${HOST})/?$`);
// Plain ws:// is for a relay on this machine only; a network gets TLS.
const LOCAL = /^ws:\/\/((?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?)\/?$/;

// wss://<host>/r/<room>?role=<pc|device>. Throws RangeError for anything that is not a plain host name.
export function relayUrl(host, room, role) {
  if (!/^[0-9a-f]{32}$/.test(room)) throw new RangeError('a room is 32 lower-case hex digits');
  if (role !== 'pc' && role !== 'device') throw new RangeError('a role is pc or device');
  const text = String(host ?? '').trim();
  const local = LOCAL.exec(text);
  if (local) return `ws://${local[1]}/r/${room}?role=${role}`;
  const secure = SECURE.exec(text);
  if (!secure) throw new RangeError(`not a relay host name: ${JSON.stringify(text)}`);
  return `wss://${secure[1]}/r/${room}?role=${role}`;
}

class RelayPort extends EventEmitter {
  kind = 'relay';
  pingEveryMs = RELAY_PING_EVERY_MS;
  pongTimeoutMs = RELAY_PONG_TIMEOUT_MS;
  closeCode = null;
  bad = 0;
  #ws;
  #closed = false;

  constructor(ws) {
    super();
    this.#ws = ws;
    ws.addEventListener('message', (e) => this.#onMessage(e.data));
    ws.addEventListener('close', (e) => this.#onClose(e.code));
  }

  get replaced() {
    return this.closeCode === CLOSE_REPLACED;
  }

  write(bytes) {
    if (this.#closed || this.#ws.readyState !== 1) return;
    let start = 0;
    for (let i = 0; i <= bytes.length; i++) {
      if (i < bytes.length && bytes[i] !== 0) continue;
      const chunk = bytes.subarray(start, i);
      start = i + 1;
      if (chunk.length === 0) continue;
      const env = cobsDecode(chunk);
      if (env && env.length >= ENVELOPE_MIN && env.length <= ENVELOPE_MAX) this.#ws.send(env);
    }
  }

  close() {
    if (this.#closed) return;
    try {
      this.#ws.close(1000);
    } catch {
      // already closing
    }
  }

  #onMessage(data) {
    if (typeof data === 'string') return;
    const env = Buffer.from(data);
    if (env.length < ENVELOPE_MIN || env.length > ENVELOPE_MAX) {
      this.bad++;
      return;
    }
    const body = cobsEncode(env);
    const wire = Buffer.alloc(body.length + 2);
    wire.set(body, 1);
    this.emit('data', wire);
  }

  #onClose(code) {
    if (this.#closed) return;
    this.#closed = true;
    this.closeCode = code;
    this.emit('close');
  }
}

// Joins the room as the PC. Resolves with the port once the relay has accepted the connection; rejects when it has not
// within connectTimeoutMs. The room is a secret of the pairing key, so no message here names it.
export function openRelayPort({ host, room, role = 'pc', connectTimeoutMs = 10_000, WebSocketImpl = WebSocket }) {
  const url = relayUrl(host, room, role);
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(url);
    ws.binaryType = 'arraybuffer';
    const port = new RelayPort(ws);
    const fail = () => {
      clearTimeout(timer);
      port.close();
      reject(new Error(`could not reach the relay at ${String(host).trim()}`));
    };
    const timer = setTimeout(fail, connectTimeoutMs);
    ws.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        ws.removeEventListener('close', fail);
        resolve(port);
      },
      { once: true },
    );
    ws.addEventListener('close', fail, { once: true });
  });
}
