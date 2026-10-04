// The room a PC and a device meet in at the relay (protocol/frames.md, "Relay"): 16 bytes that only the two holders of the pairing key can
// work out, in lower-case hex for the relay's URL. The relay learns the room and nothing else; it cannot read or forge a frame.
import { KEY_BYTES } from '../config/pairkey.js';
import { hkdf } from './session.js';

export const ROOM_INFO = 'walkie-room-v1';
export const ROOM_BYTES = 16;

export function roomId(master) {
  if (!Buffer.isBuffer(master) || master.length !== KEY_BYTES) throw new RangeError(`the pairing key is ${KEY_BYTES} bytes`);
  return hkdf(master, Buffer.alloc(0), Buffer.from(ROOM_INFO), ROOM_BYTES).toString('hex');
}
