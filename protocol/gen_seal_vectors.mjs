// Writes protocol/seal-vectors.json: the sealed-frame cases that the bridge's tests and the firmware's host tests both pass.
// It uses node:crypto directly and shares no code with bridge/src/link/session.js, so a mistake in either shows as a mismatch.
// Usage, from the repo root: node protocol/gen_seal_vectors.mjs
import { createCipheriv, hkdfSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (s) => Buffer.from(s, 'hex');

function crc16(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

const u32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
};

const hkdf = (ikm, salt, info, length) => Buffer.from(hkdfSync('sha256', ikm, salt, info, length));

const master = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const nonceP = 0x11223344;
const nonceS = 0x55667788;
const info = (dir) => Buffer.concat([Buffer.from('walkie-session-v1'), u32(nonceP), u32(nonceS), Buffer.from([dir])]);
const keys = { 1: hkdf(master, Buffer.alloc(0), info(1), 32), 2: hkdf(master, Buffer.alloc(0), info(2), 32) };

// One sealed envelope, before COBS: type, flags with bit 7, seq, len, counter, ciphertext, tag, CRC-16.
function sealed({ dir, type, flags, seq, counter, plain }) {
  const len = 4 + plain.length + 16;
  const head = Buffer.alloc(6);
  head[0] = type;
  head[1] = flags | 0x80;
  head.writeUInt16LE(seq, 2);
  head.writeUInt16LE(len, 4);
  const aad = Buffer.concat([head, u32(counter)]);
  const nonce = Buffer.alloc(12);
  nonce.writeUInt32LE(dir, 0);
  nonce.writeBigUInt64LE(BigInt(counter), 4);
  const c = createCipheriv('aes-256-gcm', keys[dir], nonce, { authTagLength: 16 });
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  const tag = c.getAuthTag();
  const body = Buffer.concat([head, u32(counter), ct, tag]);
  const envelope = Buffer.concat([body, Buffer.from([crc16(body) & 0xff, crc16(body) >> 8])]);
  return { dir, type, flags, seq, counter, plain: hex(plain), envelope: hex(envelope) };
}

const ramp = (n, from = 0) => Buffer.from(Array.from({ length: n }, (_, i) => (from + i * 7) & 0xff));
const frames = [
  sealed({ dir: 1, type: 0x02, flags: 0, seq: 7, counter: 0, plain: u32(0x12345678) }),
  sealed({ dir: 2, type: 0x03, flags: 0, seq: 8, counter: 0, plain: Buffer.concat([u32(0x12345678), u32(5000), u32(1), u32(2)]) }),
  sealed({ dir: 2, type: 0x10, flags: 0x01, seq: 10, counter: 41, plain: ramp(164) }),
  sealed({ dir: 1, type: 0x11, flags: 0x00, seq: 65535, counter: 0xfffffffe, plain: ramp(1004) }),
  sealed({ dir: 2, type: 0x3f, flags: 0, seq: 0, counter: 1, plain: Buffer.alloc(0) }),
];

// The receive rule: a counter is accepted only when it is above every one accepted before it.
const replay = { counters: [0, 1, 2, 2, 1, 5, 4, 6, 0xffffffff, 0xffffffff], accepted: [1, 1, 1, 0, 0, 1, 0, 1, 1, 0] };

// The room a PC and a device meet in at the relay (plan 6): the first 16 bytes of HKDF-SHA256(master, empty salt, "walkie-room-v1").
const roomOf = (key) => hex(hkdf(key, Buffer.alloc(0), Buffer.from('walkie-room-v1'), 16));
const otherMaster = Buffer.from(Array.from({ length: 32 }, (_, i) => 255 - i));
const room = { info: 'walkie-room-v1', cases: [master, otherMaster].map((key) => ({ master: hex(key), id: roomOf(key) })) };

const out = {
  hkdf: [
    {
      name: 'RFC 5869 test case 1',
      ikm: '0b'.repeat(22),
      salt: '000102030405060708090a0b0c',
      info: 'f0f1f2f3f4f5f6f7f8f9',
      length: 42,
      okm: hex(hkdf(unhex('0b'.repeat(22)), unhex('000102030405060708090a0b0c'), unhex('f0f1f2f3f4f5f6f7f8f9'), 42)),
    },
    {
      name: 'RFC 5869 test case 3, empty salt and info',
      ikm: '0b'.repeat(22),
      salt: '',
      info: '',
      length: 42,
      okm: hex(hkdf(unhex('0b'.repeat(22)), Buffer.alloc(0), Buffer.alloc(0), 42)),
    },
  ],
  session: { master: hex(master), nonceP, nonceS, pcToS3: hex(keys[1]), s3ToPc: hex(keys[2]) },
  frames,
  replay,
  room,
};
writeFileSync(new URL('./seal-vectors.json', import.meta.url), `${JSON.stringify(out, null, 1)}\n`);
