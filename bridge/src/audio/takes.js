// Collects AUDIO_UP frames into takes: one take per hold of the talk key, ended by the EOS flag.
import { FLAG } from '../link/frame.js';

export class TakeCollector {
  #parts = [];
  #open = false;
  #reason = false;

  get open() {
    return this.#open;
  }

  // True when the take that was last returned was recorded to give the reason for denying an approval (REASON on its last frame).
  get lastReason() {
    return this.#reason;
  }

  // Returns the finished take (PCM16 at 16 kHz) on the frame that ends it, otherwise null.
  push(frame) {
    if (frame.payload.length > 0) this.#parts.push(frame.payload);
    this.#open = true;
    if (!(frame.flags & FLAG.EOS)) return null;
    this.#reason = (frame.flags & FLAG.REASON) !== 0;
    const take = Buffer.concat(this.#parts);
    this.reset();
    return take;
  }

  reset() {
    this.#parts = [];
    this.#open = false;
  }
}
