// Sealed frames (protocol/frames.md, "Sealed frames"): the session keys and the AES-256-GCM seal around a frame's payload.
// Pure: no I/O and no clock. A Session belongs to one handshake; a new HELLO makes a new Session.
import { createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';

export const DIR = Object.freeze({ PC_TO_S3: 1, S3_TO_PC: 2 });
export const SEALED = 0x80; // flags bit 7
export const COUNTER_BYTES = 4;
export const TAG_BYTES = 16;
export const OVERHEAD = COUNTER_BYTES + TAG_BYTES;
export const MAX_PLAIN = 1024 - OVERHEAD; // what a sealed payload may hold: 1004 bytes
const LAST_COUNTER = 0xffffffff;

const u32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
};

export const hkdf = (ikm, salt, info, length) => Buffer.from(hkdfSync('sha256', ikm, salt, info, length));

// One key for each direction, from the master key and the two nonces of the handshake.
export function deriveKeys(master, nonceP, nonceS) {
  const info = (dir) => Buffer.concat([Buffer.from('walkie-session-v1'), u32(nonceP), u32(nonceS), Buffer.from([dir])]);
  const empty = Buffer.alloc(0);
  return {
    pcToS3: hkdf(master, empty, info(DIR.PC_TO_S3), 32),
    s3ToPc: hkdf(master, empty, info(DIR.S3_TO_PC), 32),
  };
}

function nonceFor(dir, counter) {
  const n = Buffer.alloc(12);
  n.writeUInt32LE(dir, 0);
  n.writeBigUInt64LE(BigInt(counter), 4);
  return n;
}

// The bytes the tag covers besides the payload: the frame's type, flags, seq and sealed length, then the counter.
function aadFor(type, flags, seq, sealedLen, counter) {
  const head = Buffer.alloc(6);
  head[0] = type;
  head[1] = flags;
  head.writeUInt16LE(seq, 2);
  head.writeUInt16LE(sealedLen, 4);
  return Buffer.concat([head, u32(counter)]);
}

export class Session {
  #sendKey;
  #recvKey;
  #sendDir;
  #recvDir;
  #next;
  #last = -1;
  #failures = 0;

  // role: 'pc' seals toward the S3 and opens what the S3 sealed; 's3' is the reverse. `counter` is where sending starts.
  constructor({ master, nonceP, nonceS, role, counter = 0 }) {
    if (role !== 'pc' && role !== 's3') throw new RangeError(`role must be 'pc' or 's3', not ${role}`);
    const keys = deriveKeys(master, nonceP, nonceS);
    const pc = role === 'pc';
    this.#sendKey = pc ? keys.pcToS3 : keys.s3ToPc;
    this.#recvKey = pc ? keys.s3ToPc : keys.pcToS3;
    this.#sendDir = pc ? DIR.PC_TO_S3 : DIR.S3_TO_PC;
    this.#recvDir = pc ? DIR.S3_TO_PC : DIR.PC_TO_S3;
    this.#next = counter;
  }

  // Refusals in a row since the last frame that opened.
  get failures() {
    return this.#failures;
  }

  // Returns the frame to hand to encodeFrame: the seal bit set, and counter, ciphertext and tag as the payload.
  seal({ type, flags = 0, seq, payload = Buffer.alloc(0) }) {
    if (payload.length > MAX_PLAIN) throw new RangeError(`a sealed payload holds at most ${MAX_PLAIN} bytes, not ${payload.length}`);
    if (this.#next > LAST_COUNTER) throw new RangeError('the send counter is used up: start the link over');
    const counter = this.#next++;
    const sealedFlags = flags | SEALED;
    const c = createCipheriv('aes-256-gcm', this.#sendKey, nonceFor(this.#sendDir, counter), { authTagLength: TAG_BYTES });
    c.setAAD(aadFor(type, sealedFlags, seq, OVERHEAD + payload.length, counter));
    const ct = Buffer.concat([c.update(payload), c.final()]);
    return { type, flags: sealedFlags, seq, payload: Buffer.concat([u32(counter), ct, c.getAuthTag()]) };
  }

  // { ok: true, frame } with the seal bit cleared and the plain payload, or { ok: false, reason } with reason one of
  // 'plain', 'short', 'replay' and 'tag'. A refused frame changes nothing but the failure count.
  open(frame) {
    const refuse = (reason) => {
      this.#failures++;
      return { ok: false, reason };
    };
    if (!(frame.flags & SEALED)) return refuse('plain');
    const p = frame.payload;
    if (p.length < OVERHEAD) return refuse('short');
    const counter = p.readUInt32LE(0);
    if (counter <= this.#last) return refuse('replay');
    const d = createDecipheriv('aes-256-gcm', this.#recvKey, nonceFor(this.#recvDir, counter), { authTagLength: TAG_BYTES });
    d.setAAD(aadFor(frame.type, frame.flags, frame.seq, p.length, counter));
    d.setAuthTag(p.subarray(p.length - TAG_BYTES));
    let plain;
    try {
      plain = Buffer.concat([d.update(p.subarray(COUNTER_BYTES, p.length - TAG_BYTES)), d.final()]);
    } catch {
      return refuse('tag');
    }
    this.#last = counter;
    this.#failures = 0;
    return { ok: true, frame: { type: frame.type, flags: frame.flags & ~SEALED, seq: frame.seq, payload: plain } };
  }
}
