// What the S3 does with a NET request (firmware/lib/proto/src/proto/netconf.cpp and messages.cpp), in JS, for the stand-in S3: the same
// limits and the same answers, so that the commands that set the networks can be tried against it. Whether the real S3 agrees is
// what gate M is for.
import { NET_ERR, NET_LIMITS, NET_OP } from '../../src/link/messages.js';

const HOST_RE = /^[A-Za-z0-9.-]+$/;

// The text that starts at `at`, led by its length: [bytes, index after it], or null when it runs past the end.
function text(p, at) {
  if (at >= p.length || at + 1 + p[at] > p.length) return null;
  return [p.subarray(at + 1, at + 1 + p[at]), at + 1 + p[at]];
}

const reply = (...bytes) => Buffer.from(bytes);

export class FakeNetConf {
  nets = []; // { ssid, pass } in the order they were added
  relay = null;
  failSave = false; // true: nothing can be stored, so every change answers ERR STORE
  generation = 0;

  // A request as the S3 parses it: { op, ssid, pass, host } with strings, or null when it breaks the frame's rules.
  static parse(p) {
    if (p.length < 1) return null;
    const op = p[0];
    if (op === NET_OP.WIFI_LIST || op === NET_OP.RELAY_CLEAR) return p.length === 1 ? { op } : null;
    if (op === NET_OP.RELAY_SET) {
      const h = text(p, 1);
      if (!h || h[1] !== p.length || h[0].length < 1 || h[0].length > NET_LIMITS.host) return null;
      const host = h[0].toString('latin1');
      return HOST_RE.test(host) ? { op, host } : null;
    }
    if (op !== NET_OP.WIFI_ADD && op !== NET_OP.WIFI_REMOVE) return null;
    const s = text(p, 1);
    if (!s || s[0].length < 1 || s[0].length > NET_LIMITS.ssid || s[0].includes(0)) return null;
    if (op === NET_OP.WIFI_REMOVE) return s[1] === p.length ? { op, ssid: s[0].toString('utf8') } : null;
    const w = text(p, s[1]);
    if (!w || w[1] !== p.length || w[0].length > NET_LIMITS.pass || (w[0].length > 0 && w[0].length < 8) || w[0].includes(0)) return null;
    return { op, ssid: s[0].toString('utf8'), pass: w[0].toString('utf8') };
  }

  // The reply payload to a request, or null when it is not a valid one (the S3 drops it).
  handle(p) {
    const m = FakeNetConf.parse(p);
    if (!m) return null;
    const bad = (why) => reply(NET_OP.ERR, m.op, why);
    const save = (change) => {
      if (this.failSave) return bad(NET_ERR.STORE);
      change();
      this.generation++;
      return reply(NET_OP.OK, m.op);
    };
    const at = this.nets.findIndex((n) => n.ssid === m.ssid);
    switch (m.op) {
      case NET_OP.WIFI_ADD:
        if (at >= 0) return this.nets[at].pass === m.pass ? reply(NET_OP.OK, m.op) : save(() => (this.nets[at].pass = m.pass));
        if (this.nets.length >= NET_LIMITS.networks) return bad(NET_ERR.FULL);
        return save(() => this.nets.push({ ssid: m.ssid, pass: m.pass }));
      case NET_OP.WIFI_REMOVE:
        return at < 0 ? bad(NET_ERR.UNKNOWN) : save(() => this.nets.splice(at, 1));
      case NET_OP.RELAY_SET:
        return this.relay === m.host ? reply(NET_OP.OK, m.op) : save(() => (this.relay = m.host));
      case NET_OP.RELAY_CLEAR:
        return this.relay === null ? reply(NET_OP.OK, m.op) : save(() => (this.relay = null));
      default: {
        const parts = [reply(NET_OP.LIST, this.nets.length)];
        for (const n of this.nets) parts.push(reply(Buffer.byteLength(n.ssid)), Buffer.from(n.ssid));
        const host = Buffer.from(this.relay ?? '', 'latin1');
        parts.push(reply(host.length), host);
        return Buffer.concat(parts); // never a password
      }
    }
  }
}
