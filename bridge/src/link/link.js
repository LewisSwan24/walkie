// The bridge's end of the USB link (protocol/frames.md). HELLO finds walkie, PING watches it,
// CREDIT paces AUDIO_DOWN, and PLAYED ends each reply.
import { randomInt } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { crc32 } from 'node:zlib';
import { decodeAdpcm, encodeAdpcm } from './adpcm.js';
import { CreditGate } from './credits.js';
import { FrameDecoder } from './decoder.js';
import { CODEC, CODEC_MASK, FLAG, TYPE, codecFlags, codecOf, encodeFrame } from './frame.js';
import { MAX_PLAIN, Session } from './session.js';
import {
  CMD, TEST_OP, cmdPayload, helloPayload, parseCredit, parseHello, parsePlayed, parsePong, pingPayload, testPayload,
} from './messages.js';

const DOWN_FRAME = 960; // 20 ms at 24 kHz
const HELLO_EVERY_MS = 1000;
const PING_EVERY_MS = 1000;
const PONG_TIMEOUT_MS = 3000;
// A port's own clock, when it is a usable number of milliseconds.
const clockOf = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback);
const PLAYED_GRACE_MS = 10_000;
const CREDIT_STALL_MS = 5000;
const PROOF_WAIT_MS = 3000; // a sealed HELLO answer that has not been proved by a frame that opens by now means the keys differ
const REFUSALS_IN_A_ROW = 8;
const NOT_PAIRED = 'walkie is not paired with this PC (or was reset): connect it with the USB cable and run `walkie pair`';
const TOO_OLD =
  'walkie runs firmware that cannot seal frames, and this PC holds a pairing key: flash the new firmware, then run `walkie pair`';
const PAIRED_ELSEWHERE = 'walkie is paired, but this PC has no key for it: connect it with the USB cable and run `walkie pair`';
const WRONG_KEY =
  "walkie did not answer under this PC's pairing key (is it paired with another PC?): connect it with the USB cable and run `walkie pair`";

export class Link extends EventEmitter {
  #openPort;
  #retryMs;
  #retryMaxMs;
  #retryDelay;
  #pingEveryMs = PING_EVERY_MS;
  #pongTimeoutMs = PONG_TIMEOUT_MS;
  #makeNonce;
  #nonce = 0;
  #port = null;
  #decoder = new FrameDecoder();
  #credits = new CreditGate();
  #seq = 0;
  #rxSeq = null;
  #gaps = 0;
  #ready = false;
  #closing = false;
  #openFailures = 0;
  #helloTimer = null;
  #pingTimer = null;
  #retryTimer = null;
  #lastPong = 0;
  #token = 0;
  #pingSent = new Map();
  #stream = null;
  #ringBytes = 0;
  #master;
  #pairing;
  #firstCounter;
  #session = null; // set once the S3 answers HELLO with proto 2 and paired
  #pending = false; // the session exists but no frame has opened under it yet
  #pendingSince = 0;
  #warned = false;
  #announced = false;
  #helloInfo = null;
  #adpcmWanted;
  #adpcm = false; // wanted, and the walkie said it takes it
  #warnedAdpcm = false;
  #warnedAudio = false;
  badAudioFrames = 0; // AUDIO_UP frames dropped for not decoding

  // `master`: the 32-byte pairing key. With one, the link talks only sealed (protocol/frames.md, "Sealed frames"); without one it
  // is plain, and refuses a walkie that is paired. `pairing` is for `walkie pair`: a plain link that holds no key and does not
  // ping, and hands up only PAIR frames. `firstCounter` is the first send counter of a session, for tests. `adpcm`: send replies as ADPCM and
  // ask the walkie for ADPCM takes, when the walkie says it takes it (protocol/frames.md, "Audio codec"); listeners get PCM16 either way.
  // `retryMs` is the first wait before the port is opened again; with `retryMaxMs` above it each wait doubles up to that, and starts over at
  // `retryMs` once a link is ready. A port may carry its own clock: `pingEveryMs` and `pongTimeoutMs` (a relay is slower than a cable).
  constructor({ openPort, retryMs = 1000, retryMaxMs = retryMs, makeNonce = () => randomInt(1, 0x100000000), master = null, pairing = false, firstCounter = 0, adpcm = false }) {
    super();
    if (master !== null && !(master instanceof Uint8Array && master.length === 32)) throw new TypeError('master must be 32 bytes');
    if (master !== null && pairing) throw new TypeError('a link that is pairing holds no key');
    this.#openPort = openPort;
    this.#retryMs = retryMs;
    this.#retryMaxMs = Math.max(retryMs, retryMaxMs);
    this.#retryDelay = retryMs;
    this.#makeNonce = makeNonce;
    this.#master = master;
    this.#pairing = pairing;
    this.#firstCounter = firstCounter;
    this.#adpcmWanted = adpcm;
  }

  get ready() {
    return this.#ready;
  }
  get credit() {
    return this.#credits.available;
  }
  get seqGaps() {
    return this.#gaps;
  }
  get badChunks() {
    return this.#decoder.bad;
  }

  async start() {
    this.#closing = false;
    await this.#connect();
  }

  close() {
    this.#closing = true;
    clearTimeout(this.#retryTimer);
    this.#stopTimers();
    this.#port?.close();
  }

  send(type, payload = Buffer.alloc(0), flags = 0) {
    if (!this.#port) return false;
    let frame = { type, flags, seq: this.#seq, payload };
    const open = type === TYPE.HELLO || type === TYPE.PAIR; // the two that are always plain
    if (this.#master && !this.#session && !open) return false; // a link with a key has no plain frames, session or not
    if (this.#session && !open) {
      if (payload.length > MAX_PLAIN) throw new RangeError(`a sealed payload holds at most ${MAX_PLAIN} bytes, not ${payload.length}`);
      try {
        frame = this.#session.seal(frame);
      } catch (err) {
        this.#lost(`the send counter is used up (${err.message})`); // never send it plain instead
        return false;
      }
    }
    this.#port.write(encodeFrame(frame));
    this.#seq = (this.#seq + 1) & 0xffff;
    return true;
  }

  cmd(op, arg) {
    return this.send(TYPE.CMD, cmdPayload(op, arg));
  }

  testUpPattern(frames) {
    return this.send(TYPE.TEST, testPayload(TEST_OP.UP_PATTERN, frames));
  }

  // Sends one reply as AUDIO_DOWN under credit and resolves with the S3's PLAYED.
  async playAudio(pcm, { signal } = {}) {
    this.#assertCanPlay();
    if (pcm.length % 2 !== 0) throw new RangeError('PCM16 needs an even number of bytes');
    return this.#play([pcm], signal);
  }

  // The same for a reply that is still being produced: `chunks` is an iterable or async iterable of PCM16 buffers
  // (24 kHz mono, any sizes, even ones that split a sample). The first frame leaves as soon as more audio is known to
  // follow it, so speech starts while the rest is still coming. Aborting `signal` stops reading `chunks` as well. If
  // `chunks` fails, what was already produced is played to its end and the failure is thrown after PLAYED.
  async playStream(chunks, { signal } = {}) {
    if (chunks instanceof Uint8Array) throw new TypeError('playStream wants an iterable of buffers; playAudio takes one buffer');
    this.#assertCanPlay();
    return this.#play(chunks, signal);
  }

  #assertCanPlay() {
    if (!this.#ready) throw new Error('the S3 is not connected');
    if (this.#ringBytes === 0) throw new Error('the S3 reports no playback ring (ring_bytes 0), so it cannot play replies');
    if (this.#stream) throw new Error('another reply is still playing');
  }

  async #play(chunks, signal) {
    const source = chunks?.[Symbol.asyncIterator]?.() ?? chunks?.[Symbol.iterator]?.(); // taken before any state is set: a non-iterable must leave the link free
    if (!source) throw new TypeError('playStream wants an iterable of buffers; playAudio takes one buffer');
    const stop = new AbortController();
    const stream = { stop, sent: 0, error: null, index: 0, crc: 0 }; // sent and crc are of the PCM the walkie will have, decoded
    stream.played = new Promise((resolve, reject) => Object.assign(stream, { resolve, reject }));
    stream.played.catch(() => {}); // failures reach the caller through the await below
    this.#stream = stream;
    const onAbort = () => {
      if (stop.signal.aborted) return;
      stop.abort();
      if (stream.sent > 0) this.cmd(CMD.STOP_AUDIO); // the S3 answers with PLAYED, reason 1
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const STOPPED = Symbol('stopped');
    const stopped = new Promise((resolve) => {
      if (stop.signal.aborted) resolve(STOPPED);
      else stop.signal.addEventListener('abort', () => resolve(STOPPED), { once: true });
    });
    const pull = async () => {
      const next = Promise.resolve(source.next());
      next.catch(() => {}); // an abort can leave it unanswered, and a late failure is not the caller's business
      const r = await Promise.race([next, stopped]);
      return r === STOPPED ? null : r;
    };
    const release = () => Promise.resolve(source.return?.()).catch(() => {}); // lets a generator clean up, for example cancel its request
    let timer;
    let sourceError = null;
    try {
      let carry = Buffer.alloc(0);
      let done = false;
      let eos = false;
      while (!eos && !stop.signal.aborted) {
        // A frame leaves only when more audio is known to follow it, so that the last one can carry EOS.
        while (!done && carry.length <= DOWN_FRAME) {
          let r;
          try {
            r = await pull();
          } catch (err) {
            sourceError = err;
            done = true;
            break;
          }
          if (r === null) break;
          if (r.done) done = true;
          else if (r.value.length > 0) carry = Buffer.concat([carry, r.value]);
        }
        if (stop.signal.aborted) break;
        const last = done && carry.length <= DOWN_FRAME;
        const n = last ? carry.length - (carry.length % 2) : DOWN_FRAME; // a dangling odd byte at the very end is dropped
        const stall = setTimeout(() => this.#lost('credit stalled for 5 s'), CREDIT_STALL_MS);
        try {
          await this.#credits.acquire(n, stop.signal);
        } catch {
          break;
        } finally {
          clearTimeout(stall);
        }
        const chunk = carry.subarray(0, n);
        let payload = chunk;
        let flags = last ? FLAG.EOS : 0;
        let heard = chunk;
        if (this.#adpcm && n > 0) {
          const r = encodeAdpcm(chunk, stream.index);
          stream.index = r.index;
          payload = r.frame;
          flags |= codecFlags(CODEC.ADPCM);
          heard = decodeAdpcm(r.frame); // what the walkie will decode, so that PLAYED can be checked
        }
        this.send(TYPE.AUDIO_DOWN, payload, flags);
        stream.sent += n;
        stream.crc = crc32(heard, stream.crc);
        carry = carry.subarray(last ? carry.length : n);
        eos = last;
      }
      release(); // reading is over, whether the source ended or not
      if (stream.error) throw stream.error;
      if (!eos) {
        if (stream.sent === 0) return { bytes: 0, crc32: 0, underruns: 0, maxFill: 0, reason: 1 }; // nothing was sent: there is nothing to expect
        this.send(TYPE.AUDIO_DOWN, Buffer.alloc(0), FLAG.EOS); // ends the S3's discarding
      }
      timer = setTimeout(
        () => this.#failStream(new Error('the S3 never reported the end of playback')),
        Math.ceil(stream.sent / 48) + PLAYED_GRACE_MS,
      );
      const played = await stream.played;
      if (sourceError && !stop.signal.aborted) throw sourceError;
      return { ...played, expected: { bytes: stream.sent, crc32: stream.crc } }; // of what was sent: a reply that was stopped played less
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (this.#stream === stream) this.#stream = null;
      release();
    }
  }

  async #connect() {
    if (this.#closing) return;
    let port;
    try {
      port = await this.#openPort();
    } catch (err) {
      if (this.#openFailures++ === 0) this.emit('status', `cannot open the S3's port (${err.message}); retrying`);
      const wait = err?.retryInMs;
      this.#scheduleRetry(Number.isFinite(wait) && wait > 0 ? wait : null); // an open may say how soon to try again
      return;
    }
    if (this.#closing) {
      port.close();
      return;
    }
    this.#openFailures = 0;
    this.#port = port;
    this.#pingEveryMs = clockOf(port.pingEveryMs, PING_EVERY_MS);
    this.#pongTimeoutMs = clockOf(port.pongTimeoutMs, PONG_TIMEOUT_MS);
    this.#decoder = new FrameDecoder();
    this.#rxSeq = null;
    port.on('data', (buf) => {
      for (const f of this.#decoder.push(buf)) this.#onFrame(f);
    });
    port.on('close', () => this.#onClose(port));
    port.on('error', (err) => this.emit('status', `port error: ${err.message}`));
    this.#startHello();
  }

  #onClose(port) {
    if (port !== this.#port) return;
    this.#port = null;
    const wasReady = this.#ready;
    this.#ready = false;
    this.#dropSession();
    this.#stopTimers();
    this.#credits.reset();
    this.#failStream(new Error('the S3 port closed'));
    if (wasReady && !this.#closing) this.emit('down', 'port closed');
    if (!this.#closing) this.#scheduleRetry();
  }

  // `fixed`: a wait the failed open asked for. It is taken as it is and does not count towards the backoff.
  #scheduleRetry(fixed = null) {
    this.#retryTimer = setTimeout(() => this.#connect(), fixed ?? this.#retryDelay);
    if (fixed === null) this.#retryDelay = Math.min(this.#retryMaxMs, this.#retryDelay * 2);
  }

  // A new handshake: a new nonce, HELLO now and once a second until the S3 answers it.
  #startHello() {
    this.#nonce = this.#makeNonce();
    this.#dropSession();
    clearInterval(this.#helloTimer);
    this.#sayHello();
    this.#helloTimer = setInterval(() => {
      this.#sayHello();
      if (this.#pending && !this.#warned && Date.now() - this.#pendingSince >= PROOF_WAIT_MS) this.#warn(WRONG_KEY);
    }, HELLO_EVERY_MS);
  }

  #dropSession() {
    this.#session = null;
    this.#pending = false;
    this.#warned = false;
    this.#announced = false;
  }

  // Said once for a handshake, however many HELLOs it takes.
  #warn(message) {
    if (this.#warned) return;
    this.#warned = true;
    this.emit('status', message);
  }

  #sayHello() {
    this.send(TYPE.HELLO, helloPayload(this.#nonce));
  }

  #onFrame(f) {
    if (f.type === TYPE.HELLO) {
      const hello = parseHello(f.payload);
      if (hello) this.#onDeviceHello(hello, f.seq);
      return;
    }
    if (this.#pairing) {
      if (this.#ready && f.type === TYPE.PAIR) this.emit('frame', f);
      return;
    }
    if (this.#session) {
      const opened = this.#session.open(f);
      if (!opened.ok) {
        if (this.#ready && this.#session.failures >= REFUSALS_IN_A_ROW) this.#lost(`${REFUSALS_IN_A_ROW} frames refused in a row`);
        return;
      }
      f = opened.frame;
      if (this.#pending) this.#becomeReady(f.seq);
    }
    if (!this.#ready) return; // left over from before walkie answered
    if (this.#rxSeq !== null && f.seq !== ((this.#rxSeq + 1) & 0xffff)) this.#gaps++;
    this.#rxSeq = f.seq;
    switch (f.type) {
      case TYPE.PONG:
        this.#onPong(parsePong(f.payload));
        break;
      case TYPE.CREDIT: {
        const c = parseCredit(f.payload);
        if (c) this.#credits.grant(c.bytes);
        break;
      }
      case TYPE.AUDIO_UP:
        this.#onAudioUp(f);
        break;
      case TYPE.PLAYED: {
        const p = parsePlayed(f.payload);
        if (p) this.#onPlayed(p);
        break;
      }
      case TYPE.LOG:
        this.emit('log', f.payload.toString('utf8'));
        break;
      default:
        this.emit('frame', f);
    }
  }

  // Listeners get PCM16 whatever the walkie sent. A frame that does not decode is dropped and counted, and said once.
  #onAudioUp(f) {
    const codec = codecOf(f.flags);
    if (f.payload.length === 0 || codec === CODEC.PCM16) {
      this.emit('audio-up', codec === CODEC.PCM16 ? f : { ...f, flags: f.flags & ~CODEC_MASK }); // an empty EOS frame stays empty
      return;
    }
    const pcm = codec === CODEC.ADPCM ? decodeAdpcm(f.payload) : null;
    if (pcm === null) {
      this.badAudioFrames++;
      if (!this.#warnedAudio) {
        this.#warnedAudio = true;
        this.emit('status', `an AUDIO_UP frame with codec ${codec} did not decode and was dropped`);
      }
      return;
    }
    this.emit('audio-up', { ...f, flags: f.flags & ~CODEC_MASK, payload: pcm });
  }

  #onDeviceHello(hello, seq) {
    if (hello.nonce === this.#nonce) {
      this.#onAnswer(hello, seq);
      return;
    }
    if (hello.nonce === 0 && this.#ready) this.#lost('the S3 restarted'); // its boot HELLO
    // Anything else was queued before this bridge opened the port.
  }

  // An answer to this handshake: the S3 has just started the link over.
  #onAnswer(hello, seq) {
    if (!this.#pairing) {
      const sealed = this.#master !== null;
      let problem = null;
      if (sealed) problem = hello.proto < 2 ? TOO_OLD : hello.paired ? null : NOT_PAIRED;
      else if (hello.paired) problem = PAIRED_ELSEWHERE;
      if (problem) {
        if (this.#ready) this.#lost(problem);
        else this.#warn(problem);
        return;
      }
    }
    this.#rxSeq = seq;
    this.#gaps = 0;
    this.#credits.reset();
    this.#failStream(new Error('the S3 started the link over'));
    this.#helloInfo = hello;
    this.#adpcm = this.#adpcmWanted && hello.adpcm === true;
    if (this.#adpcmWanted && !this.#adpcm && !this.#warnedAdpcm) {
      this.#warnedAdpcm = true;
      this.emit('status', 'walkie does not take ADPCM (older firmware): replies and takes stay PCM16');
    }
    if (!this.#master) {
      this.#becomeReady();
      return;
    }
    // Sealed: the keys come from both nonces, so every answer is a new session. The link is ready once a frame opens under it,
    // which only a walkie that holds the same key can make; until then HELLO goes on.
    this.#session = new Session({ master: this.#master, nonceP: this.#nonce, nonceS: hello.nonceS, role: 'pc', counter: this.#firstCounter });
    if (this.#ready) {
      this.#askForAdpcm();
      return;
    }
    if (!this.#pending) {
      this.#pending = true;
      this.#pendingSince = Date.now();
    }
    this.#sendPing();
  }

  #becomeReady() {
    const hello = this.#helloInfo;
    this.#pending = false;
    this.#ready = true;
    this.#retryDelay = this.#retryMs;
    this.#ringBytes = hello.ringBytes;
    clearInterval(this.#helloTimer);
    this.#helloTimer = null;
    clearInterval(this.#pingTimer);
    this.#pingTimer = null;
    if (!this.#pairing) {
      this.#lastPong = Date.now();
      this.#pingTimer = setInterval(() => this.#ping(), this.#pingEveryMs);
      this.#ping(); // at once: the S3 shows its offline screen until it has had one
    }
    this.#askForAdpcm();
    if (!this.#announced) {
      this.#announced = true;
      this.emit('hello', hello);
    }
  }

  // A HELLO puts the walkie's uplink back to PCM16, so this follows every answer that starts a session.
  #askForAdpcm() {
    if (this.#adpcm) this.cmd(CMD.SET_CODEC, 1);
  }

  #ping() {
    if (Date.now() - this.#lastPong > this.#pongTimeoutMs) {
      this.#lost(`no PONG for ${this.#pongTimeoutMs / 1000} s`);
      return;
    }
    this.#sendPing();
  }

  #sendPing() {
    this.#token = (this.#token + 1) >>> 0;
    this.#pingSent.set(this.#token, Date.now());
    if (this.#pingSent.size > 8) this.#pingSent.delete(this.#pingSent.keys().next().value);
    this.send(TYPE.PING, pingPayload(this.#token));
  }

  #onPong(p) {
    if (!p) return;
    this.#lastPong = Date.now();
    const sent = this.#pingSent.get(p.token);
    this.#pingSent.delete(p.token);
    this.emit('pong', { ...p, rttMs: sent === undefined ? null : Date.now() - sent });
  }

  #onPlayed(p) {
    this.emit('played', p);
    const s = this.#stream;
    if (!s) return;
    if (p.reason === 1) s.stop.abort(); // the S3 stopped it: stop sending
    s.resolve(p);
  }

  #lost(reason) {
    this.#ready = false;
    this.#dropSession();
    this.#stopTimers();
    this.#credits.reset();
    this.#failStream(new Error(`lost the S3: ${reason}`));
    this.emit('down', reason);
    if (this.#port) this.#startHello();
  }

  #failStream(err) {
    const s = this.#stream;
    if (!s) return;
    s.error = err;
    s.stop.abort();
    s.reject(err);
  }

  #stopTimers() {
    clearInterval(this.#helloTimer);
    clearInterval(this.#pingTimer);
    this.#helloTimer = null;
    this.#pingTimer = null;
  }
}
