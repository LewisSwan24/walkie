// One frame of the link (protocol/frames.md): type, flags, seq, len, payload, CRC-16, all little endian,
// then COBS, with a 0x00 before and after.
import { crc16 } from './crc16.js';
import { cobsEncode, cobsDecode } from './cobs.js';

export const TYPE = Object.freeze({
  HELLO: 0x01,
  PING: 0x02,
  PONG: 0x03,
  AUDIO_UP: 0x10,
  AUDIO_DOWN: 0x11,
  CREDIT: 0x12,
  PLAYED: 0x13,
  UI: 0x20,
  BUTTON: 0x21,
  APPROVAL_REQ: 0x22,
  APPROVAL_RES: 0x23,
  CMD: 0x30,
  TEST: 0x31,
  PAIR: 0x32,
  NET: 0x33,
  LOG: 0x3f,
});
export const FLAG = Object.freeze({ EOS: 0x01, REASON: 0x08 });
// The codec of an AUDIO frame is bits 1-2 of its flags (protocol/frames.md, "Audio codec").
export const CODEC = Object.freeze({ PCM16: 0, ADPCM: 1 });
export const CODEC_MASK = 0x06;
export const codecOf = (flags) => (flags & CODEC_MASK) >> 1;
export const codecFlags = (codec) => (codec << 1) & CODEC_MASK;
export const MAX_PAYLOAD = 1024;
export const MAX_CHUNK = 1100;

export function encodeFrame({ type, flags = 0, seq, payload = new Uint8Array(0) }) {
  if (payload.length > MAX_PAYLOAD) throw new RangeError(`payload of ${payload.length} bytes, the limit is ${MAX_PAYLOAD}`);
  const env = new Uint8Array(8 + payload.length);
  const dv = new DataView(env.buffer);
  env[0] = type;
  env[1] = flags;
  dv.setUint16(2, seq & 0xffff, true);
  dv.setUint16(4, payload.length, true);
  env.set(payload, 6);
  dv.setUint16(6 + payload.length, crc16(env.subarray(0, 6 + payload.length)), true);
  const body = cobsEncode(env);
  const wire = new Uint8Array(body.length + 2);
  wire.set(body, 1);
  return wire;
}

export function decodeChunk(chunk) {
  if (chunk.length > MAX_CHUNK) return null;
  const env = cobsDecode(chunk);
  if (!env || env.length < 8) return null;
  const dv = new DataView(env.buffer, env.byteOffset, env.length);
  const len = dv.getUint16(4, true);
  if (len > MAX_PAYLOAD || len !== env.length - 8) return null;
  if (dv.getUint16(6 + len, true) !== crc16(env.subarray(0, 6 + len))) return null;
  return { type: env[0], flags: env[1], seq: dv.getUint16(2, true), payload: Buffer.from(env.subarray(6, 6 + len)) };
}
