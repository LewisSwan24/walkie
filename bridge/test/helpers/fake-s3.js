// A stand-in for the S3 on the serial port, for tests that run the whole bridge. The Link writes frames to it and it answers the
// way walkie's firmware does: HELLO with the nonce echoed, a PONG for every PING, CREDIT for the audio it is sent, and PLAYED when
// a reply ends or is stopped. The test plays the device's own side with take(), button() and answer(). It also does what the
// firmware's TEST hooks do for a recording that is fed in as the microphone: MIC_SOURCE on, MIC_PCM into a FIFO, and KEYS with the
// front key held for a while, which makes a take of that long out of the FIFO (zeros for what has not arrived).
import { EventEmitter } from 'node:events';
import { crc32 } from 'node:zlib';
import { FLAG, TYPE, encodeFrame } from '../../src/link/frame.js';
import { decodeAdpcm, encodeAdpcm } from '../../src/link/adpcm.js';
import { FrameDecoder } from '../../src/link/decoder.js';
import { CMD, KEY, TEST_OP, parseApprovalReq, parseTestKeys, parseUi } from '../../src/link/messages.js';
import { Session } from '../../src/link/session.js';
import { FakeNetConf } from './fake-net.js';

const u32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
};

export class FakeS3 extends EventEmitter {
  sent = []; // every frame the bridge wrote, decoded, in order (a sealed one opened: the plain frame)
  raw = []; // the same frames as they arrived, a sealed one still sealed
  refused = []; // what a session would not open: { reason, frame }
  out = []; // every buffer written to the bridge, to replay
  session = null;
  #decoder = new FrameDecoder();
  #seq = 0;
  #downBytes = 0;
  #downCrc = 0;
  #adpcm;
  #upCodec = 0; // what CMD SET_CODEC last asked for; a HELLO puts it back to 0
  #upIndex = 0;
  badDown = 0; // AUDIO_DOWN frames that did not decode
  #pairMode;
  #pendingPair = null;
  pairRequests = []; // every PAIR request that came: { op, key }
  net = new FakeNetConf(); // the Wi-Fi networks and relay host a NET request sets
  netRequests = []; // every NET request that was taken (it came sealed on a paired S3): its plain payload
  netRefused = 0; // NET frames that were not taken: plain, or on an S3 with no key
  #ringBytes;
  #version;
  #proto;
  #master;
  #paired;
  #nonceS;
  #hellos = 0;
  #lastNonceP = 0;
  #fifo = Buffer.alloc(0);
  answerPings = true; // false: a PING gets no PONG, as when the cable or the network has gone quiet
  micSource = false; // TEST MIC_SOURCE
  injected = []; // the takes that TEST KEYS made out of the FIFO

  // proto 2 answers HELLO the way a walkie that can seal frames does: with nonceS and a flags byte, paired when `master` (the
  // pairing key, 32 bytes) is given. With a key it keeps the session and seals what it sends, except HELLO and PAIR.
  // `pairing` is what the person at the walkie does with a PAIR request: null (nothing is ever answered), 'yes' or 'no' (answered at once, as
  // if the front or the side key had been pressed), 'ask' (held until confirmPair()), 'lose-reply' (the key is taken but the OK never
  // arrives) or 'wrong-key' (it says OK but keeps another key). A request for the key it already holds is answered OK at once, as the
  // firmware does. `adpcm`: the HELLO flags say it takes ADPCM. It decodes AUDIO_DOWN by the codec flag whatever the flags say, and sends AUDIO_UP as
  // ADPCM once CMD SET_CODEC 1 has come.
  constructor({ ringBytes = 262144, version = '0.0.0-fake', proto = 1, master = null, nonceS = 0x0a0b0c0d, adpcm = false, pairing = null } = {}) {
    super();
    this.#ringBytes = ringBytes;
    this.#version = version;
    this.#proto = proto;
    this.#master = master;
    this.#paired = master !== null;
    this.#nonceS = nonceS;
    this.#adpcm = adpcm;
    this.#pairMode = pairing;
  }

  // The key the walkie holds, or null when it is not paired.
  get heldKey() {
    return this.#paired ? Buffer.from(this.#master) : null;
  }

  // The front key (yes) or the side key (no), pressed on the pairing screen.
  confirmPair(yes) {
    const p = this.#pendingPair;
    this.#pendingPair = null;
    if (p) this.#decidePair(p, yes ? 'yes' : 'no');
  }

  get upCodec() {
    return this.#upCodec;
  }

  // ---- the port, as the Link sees it

  write(buf) {
    for (const f of this.#decoder.push(buf)) {
      this.raw.push(f);
      let frame = f;
      if (this.session && f.type !== TYPE.HELLO && f.type !== TYPE.PAIR) {
        const r = this.session.open(f);
        if (!r.ok) {
          this.refused.push({ reason: r.reason, frame: f });
          continue;
        }
        frame = r.frame;
      }
      this.sent.push(frame);
      const sealed = Boolean(this.session) && f.type !== TYPE.HELLO && f.type !== TYPE.PAIR;
      setImmediate(() => this.#answer(frame, sealed));
    }
    return true;
  }

  close() {
    this.emit('close');
    this.removeAllListeners('data'); // a closed port says nothing more, even to a Link that is still listening
  }

  // ---- the firmware's answers

  #answer(f, sealed) {
    switch (f.type) {
      case TYPE.HELLO:
        this.#answerHello(f.payload.readUInt32LE(1));
        break;
      case TYPE.PING:
        if (this.answerPings) this.feed(TYPE.PONG, Buffer.concat([f.payload, u32(1234), u32(0), u32(0)]));
        break;
      case TYPE.AUDIO_DOWN: {
        const codec = (f.flags >> 1) & 3;
        const pcm = f.payload.length === 0 || codec === 0 ? f.payload : codec === 1 ? decodeAdpcm(f.payload) : null;
        if (pcm === null) {
          this.badDown++;
        } else {
          this.#downBytes += pcm.length;
          this.#downCrc = crc32(pcm, this.#downCrc);
          if (pcm.length > 0) this.feed(TYPE.CREDIT, u32(pcm.length));
        }
        if (f.flags & FLAG.EOS) this.#played(0);
        break;
      }
      case TYPE.CMD:
        if (f.payload[0] === CMD.STOP_AUDIO) this.#played(1);
        if (f.payload[0] === CMD.SET_CODEC) {
          this.#upCodec = f.payload[1];
          this.#upIndex = 0;
        }
        break;
      case TYPE.TEST:
        this.#test(f.payload);
        break;
      case TYPE.PAIR:
        this.#onPair(f.payload);
        break;
      case TYPE.NET: {
        // Only ever over a sealed link, as the firmware has it: a plain NET frame, or any on an S3 without a key, is dropped.
        const answer = sealed ? this.net.handle(f.payload) : null;
        if (!sealed || answer === null) {
          this.netRefused++;
          break;
        }
        this.netRequests.push(f.payload);
        this.feed(TYPE.NET, answer);
        break;
      }
      default:
    }
  }

  #onPair(p) {
    const op = p[0];
    const key = op === 1 ? Buffer.from(p.subarray(1, 33)) : null;
    this.pairRequests.push({ op, key });
    if (op === 1 && this.#paired && this.#master.equals(key)) this.#pairReply(3, op);
    else if (op === 2 && !this.#paired) this.#pairReply(3, op);
    else if (this.#pairMode === 'ask') this.#pendingPair = { op, key };
    else if (this.#pairMode) this.#decidePair({ op, key }, this.#pairMode);
  }

  #decidePair({ op, key }, mode) {
    if (mode === 'no') {
      this.#pairReply(4, op);
      return;
    }
    if (op === 1) {
      this.#master = mode === 'wrong-key' ? Buffer.alloc(32, 0x5a) : key;
      this.#paired = true;
    } else {
      this.#master = null;
      this.#paired = false;
    }
    this.session = null; // the keys that were in use came from the old key
    if (mode !== 'lose-reply') this.#pairReply(3, op);
  }

  #pairReply(reply, answered) {
    this.feed(TYPE.PAIR, Buffer.from([reply, answered]), 0, { plain: true });
  }

  #answerHello(nonceP) {
    this.#lastNonceP = nonceP;
    this.#upCodec = 0;
    this.#upIndex = 0;
    const v2 = this.#proto >= 2;
    const head = v2 ? 23 : 18;
    const hello = Buffer.alloc(head + this.#version.length);
    hello[0] = v2 ? 2 : 1;
    hello.writeUInt16LE(16000, 2);
    hello.writeUInt16LE(24000, 4);
    hello.writeUInt32LE(this.#ringBytes, 6);
    hello.writeUInt32LE(1234, 10);
    hello.writeUInt32LE(nonceP, 14);
    if (v2) {
      const nonceS = (this.#nonceS + this.#hellos++) >>> 0;
      hello.writeUInt32LE(nonceS, 18);
      hello[22] = (this.#paired ? 1 : 0) | (this.#adpcm ? 2 : 0);
      this.session = this.#master ? new Session({ master: this.#master, nonceP, nonceS, role: 's3' }) : null;
    }
    hello.write(this.#version, head);
    this.feed(TYPE.HELLO, hello);
    this.feed(TYPE.CREDIT, u32(12288));
  }

  // The S3 starts the link over again, as it does for a repeated HELLO: new session numbers, and credit from 0.
  rehello() {
    this.#answerHello(this.#lastNonceP);
  }

  #test(p) {
    if (p[0] === TEST_OP.MIC_SOURCE) {
      this.micSource = p[1] === 1;
      if (!this.micSource) this.#fifo = Buffer.alloc(0);
    } else if (p[0] === TEST_OP.MIC_PCM) {
      if (this.micSource) this.#fifo = Buffer.concat([this.#fifo, p.subarray(1)]);
    } else if (p[0] === TEST_OP.SELFTEST) {
      this.selftests = (this.selftests ?? 0) + 1;
      this.feed(TYPE.LOG, Buffer.from(this.selftestAnswer ?? 'selftest ok: hkdf gcm-seal gcm-open gcm-tamper session'));
    } else if (p[0] === TEST_OP.KEYS) {
      const { steps } = parseTestKeys(p);
      let at = 0;
      let pressedAt = null;
      for (const step of steps) {
        at += step.delayMs;
        if (step.mask & KEY.FRONT) pressedAt ??= at;
        else if (pressedAt !== null) {
          const bytes = ((at - pressedAt) * 16000 * 2) / 1000;
          const pcm = Buffer.concat([this.#fifo.subarray(0, bytes), Buffer.alloc(Math.max(0, bytes - this.#fifo.length))]);
          this.#fifo = this.#fifo.subarray(bytes);
          setTimeout(() => {
            this.injected.push(pcm);
            this.take(pcm);
          }, at - pressedAt);
          pressedAt = null;
        }
      }
    }
  }

  #played(reason) {
    this.feed(TYPE.PLAYED, Buffer.concat([u32(this.#downBytes), u32(this.#downCrc), u32(0), u32(0), Buffer.from([reason])]));
    this.#downBytes = 0;
    this.#downCrc = 0;
  }

  // ---- what the test plays

  // `plain` sends a frame unsealed even on a sealed link, as an attacker or a downgrade would.
  feed(type, payload = Buffer.alloc(0), flags = 0, { plain = false } = {}) {
    let frame = { type, flags, seq: this.#seq++, payload };
    if (this.session && !plain && type !== TYPE.HELLO && type !== TYPE.PAIR) frame = this.session.seal(frame);
    const wire = Buffer.from(encodeFrame(frame));
    this.out.push(wire);
    this.emit('data', wire);
  }

  // One take as the talk key would make it: 20 ms frames of 16 kHz PCM16, the last one carrying EOS (and REASON).
  take(pcm, { reason = false } = {}) {
    const FRAME = 640;
    for (let at = 0; at < pcm.length; at += FRAME) {
      const last = at + FRAME >= pcm.length;
      const flags = last ? FLAG.EOS | (reason ? FLAG.REASON : 0) : 0;
      if (this.#upCodec === 1) {
        const r = encodeAdpcm(pcm.subarray(at, at + FRAME), this.#upIndex);
        this.#upIndex = last ? 0 : r.index;
        this.feed(TYPE.AUDIO_UP, r.frame, flags | 0x02);
      } else {
        this.feed(TYPE.AUDIO_UP, pcm.subarray(at, at + FRAME), flags);
      }
    }
  }

  button(code) {
    this.feed(TYPE.BUTTON, Buffer.from([code]));
  }

  answer(id, allow, reasonFollows = false) {
    const p = Buffer.alloc(4);
    p.writeUInt16LE(id, 0);
    p[2] = allow ? 1 : 0;
    p[3] = reasonFollows ? 1 : 0;
    this.feed(TYPE.APPROVAL_RES, p);
  }

  // ---- what the bridge sent, read back

  frames(type) {
    return this.sent.filter((f) => f.type === type);
  }

  // The screens in the order they were sent: {state, project, text, elapsedMs} for a UI frame, {approval: {...}} for an approval.
  screens() {
    return this.sent.flatMap((f) => {
      if (f.type === TYPE.UI) return [parseUi(f.payload)];
      if (f.type === TYPE.APPROVAL_REQ) return [{ approval: parseApprovalReq(f.payload) }];
      return [];
    });
  }

  // Bytes of reply audio the bridge has sent, and whether the last of it carried EOS.
  audioDown() {
    const frames = this.frames(TYPE.AUDIO_DOWN);
    return { bytes: frames.reduce((n, f) => n + f.payload.length, 0), ended: frames.some((f) => f.flags & FLAG.EOS) };
  }
}

export async function until(check, what, ms = 20_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
