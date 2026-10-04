// Splits the byte stream on 0x00 and returns the valid frames; counts the chunks that were not frames.
import { decodeChunk, MAX_CHUNK } from './frame.js';

export class FrameDecoder {
  #buf = Buffer.alloc(MAX_CHUNK);
  #len = 0;
  #overflow = false;
  bad = 0;

  push(data) {
    const frames = [];
    for (const b of data) {
      if (b === 0) {
        if (this.#overflow) {
          this.bad++;
        } else if (this.#len > 0) {
          const f = decodeChunk(this.#buf.subarray(0, this.#len));
          if (f) frames.push(f);
          else this.bad++;
        }
        this.#len = 0;
        this.#overflow = false;
      } else if (this.#len < MAX_CHUNK) {
        this.#buf[this.#len++] = b;
      } else {
        this.#overflow = true;
      }
    }
    return frames;
  }
}
