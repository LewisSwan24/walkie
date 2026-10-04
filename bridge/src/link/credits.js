// The PC's side of AUDIO_DOWN flow control: audio goes out only against credit the S3 has granted.
export class CreditGate {
  #credit = 0;
  #waiters = [];

  get available() {
    return this.#credit;
  }

  grant(bytes) {
    this.#credit += bytes;
    this.#wake();
  }

  // Forgets all credit (the S3 said HELLO). Waiters keep waiting for new grants.
  reset() {
    this.#credit = 0;
  }

  acquire(bytes, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.#waiters.length === 0 && this.#credit >= bytes) {
      this.#credit -= bytes;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const w = { bytes, resolve, signal, onAbort: null };
      if (signal) {
        w.onAbort = () => {
          this.#waiters = this.#waiters.filter((x) => x !== w);
          this.#wake();
          reject(signal.reason);
        };
        signal.addEventListener('abort', w.onAbort, { once: true });
      }
      this.#waiters.push(w);
    });
  }

  #wake() {
    while (this.#waiters.length > 0 && this.#credit >= this.#waiters[0].bytes) {
      if (this.#waiters[0].signal?.aborted) break; // its own abort listener is about to remove it and wake the rest
      const w = this.#waiters.shift();
      this.#credit -= w.bytes;
      w.signal?.removeEventListener('abort', w.onAbort);
      w.resolve();
    }
  }
}
