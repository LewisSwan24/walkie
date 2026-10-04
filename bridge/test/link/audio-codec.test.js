// ADPCM on the link (protocol/frames.md, "Audio codec"): the Link encodes replies when it is asked to and the walkie takes it, asks for
// ADPCM from the walkie, and hands listeners PCM16 whatever the walkie sent. The stand-in S3 (test/helpers/fake-s3.js) decodes by the
// codec flag as the firmware does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { decodeAdpcm, encodeAdpcm } from '../../src/link/adpcm.js';
import { Link } from '../../src/link/link.js';
import { TYPE } from '../../src/link/frame.js';
import { CMD } from '../../src/link/messages.js';
import { FakeS3, until } from '../helpers/fake-s3.js';

const KEY = Buffer.alloc(32, 7);
const settle = () => new Promise((resolve) => setImmediate(resolve));
const tone = (samples, hz, rate) => {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * hz * i) / rate)), i * 2);
  return b;
};

async function connect(t, { s3 = {}, link: linkOptions = {} } = {}) {
  const device = new FakeS3({ proto: 2, ...s3 });
  const link = new Link({ openPort: async () => device, makeNonce: () => 0x5eed1234, ...linkOptions });
  const seen = { status: [], 'audio-up': [], played: [] };
  for (const name of Object.keys(seen)) link.on(name, (x) => seen[name].push(x));
  t.after(() => link.close());
  await link.start();
  await until(() => link.ready, 'the link to be ready');
  return { device, link, seen };
}

// What the walkie plays for `pcm` sent as ADPCM in frames of `size` bytes: the reference encoder, the index carried, then decoded.
function playedFor(pcm, size = 960) {
  let index = 0;
  const parts = [];
  for (let at = 0; at < pcm.length; at += size) {
    const r = encodeAdpcm(pcm.subarray(at, at + size), index);
    index = r.index;
    parts.push(decodeAdpcm(r.frame));
  }
  return Buffer.concat(parts);
}

const setCodecFrames = (device) => device.frames(TYPE.CMD).filter((f) => f.payload[0] === CMD.SET_CODEC);

test('with ADPCM on and a walkie that takes it, a reply goes down as 244-byte frames and credit counts the 960 decoded bytes', async (t) => {
  const { device, link } = await connect(t, { s3: { adpcm: true }, link: { adpcm: true } });
  const pcm = tone(4800, 440, 24000); // 200 ms
  const played = await link.playAudio(pcm);
  const frames = device.frames(TYPE.AUDIO_DOWN);
  assert.equal(frames.length, 10);
  assert.ok(frames.every((f) => (f.flags & 0x06) === 0x02), 'every frame carries the ADPCM codec flag');
  assert.ok(frames.every((f) => f.payload.length === 244));
  const heard = playedFor(pcm);
  assert.equal(played.bytes, 9600, 'PLAYED counts decoded bytes');
  assert.equal(played.crc32, crc32(heard), 'the walkie decoded what the reference decoder gives');
  assert.notEqual(played.crc32, crc32(pcm), 'which is not the PCM that went in: the codec is lossy');
  assert.deepEqual(played.expected, { bytes: 9600, crc32: crc32(heard) }, 'and the Link knew what to expect');
  assert.equal(device.badDown, 0);
  assert.equal(link.credit, 12288, 'credit given back for decoded bytes ends where it began');
});

test('a reply that ends on a single sample is a 4-byte frame, and the stream still ends with EOS', async (t) => {
  const { device, link } = await connect(t, { s3: { adpcm: true }, link: { adpcm: true } });
  const pcm = tone(961, 300, 24000);
  const played = await link.playAudio(pcm);
  const frames = device.frames(TYPE.AUDIO_DOWN);
  assert.deepEqual(frames.map((f) => f.payload.length), [244, 244, 4]);
  assert.ok(frames.at(-1).flags & 0x01, 'EOS on the last');
  assert.equal(played.bytes, 1922);
  assert.equal(played.expected.crc32, played.crc32);
});

test('the step index starts at 0 for each reply', async (t) => {
  const { device, link } = await connect(t, { s3: { adpcm: true }, link: { adpcm: true } });
  const loud = tone(960, 700, 24000);
  await link.playAudio(loud);
  await link.playAudio(loud);
  const firsts = device.frames(TYPE.AUDIO_DOWN).filter((f, i, all) => i === 0 || all[i - 1].flags & 0x01);
  assert.equal(firsts.length, 2);
  assert.ok(firsts.every((f) => f.payload[2] === 0), 'both replies begin at index 0');
});

test('without the option the link is PCM16 as before, and what to expect is the CRC of the PCM', async (t) => {
  const { device, link } = await connect(t, { s3: { adpcm: true } });
  const pcm = tone(2400, 440, 24000);
  const played = await link.playAudio(pcm);
  assert.ok(device.frames(TYPE.AUDIO_DOWN).every((f) => (f.flags & 0x06) === 0 && f.payload.length <= 960));
  assert.equal(played.crc32, crc32(pcm));
  assert.deepEqual(played.expected, { bytes: 4800, crc32: crc32(pcm) });
  assert.equal(setCodecFrames(device).length, 0, 'and the walkie is not asked for ADPCM');
});

test('ADPCM asked for from a walkie that does not say it takes it: PCM16, and one status says why', async (t) => {
  const { device, link, seen } = await connect(t, { s3: { adpcm: false }, link: { adpcm: true } });
  await link.playAudio(tone(1200, 440, 24000));
  assert.ok(device.frames(TYPE.AUDIO_DOWN).every((f) => (f.flags & 0x06) === 0));
  assert.equal(seen.status.filter((s) => /ADPCM/.test(s)).length, 1, JSON.stringify(seen.status));
  device.rehello();
  await settle();
  await settle();
  assert.equal(seen.status.filter((s) => /ADPCM/.test(s)).length, 1, 'said once for the link, not for every handshake');
  assert.equal(setCodecFrames(device).length, 0);
});

test('the walkie is asked for ADPCM once the link is ready, and again after every HELLO answer, since a HELLO puts it back to PCM16', async (t) => {
  const { device } = await connect(t, { s3: { adpcm: true }, link: { adpcm: true } });
  await until(() => device.upCodec === 1, 'SET_CODEC 1');
  assert.equal(setCodecFrames(device).length, 1);
  device.rehello();
  await until(() => setCodecFrames(device).length === 2, 'SET_CODEC again');
  await until(() => device.upCodec === 1, 'the walkie on ADPCM again');
});

test('on a sealed link the same: SET_CODEC goes out sealed, after the link is ready, and again after a re-key', async (t) => {
  const { device } = await connect(t, { s3: { adpcm: true, master: KEY }, link: { adpcm: true, master: KEY } });
  await until(() => device.upCodec === 1, 'SET_CODEC 1');
  assert.equal(setCodecFrames(device).length, 1);
  assert.ok(device.raw.filter((f) => f.type === TYPE.CMD).every((f) => f.flags & 0x80), 'sealed');
  device.rehello();
  await until(() => setCodecFrames(device).length === 2, 'SET_CODEC after the re-key');
  await until(() => device.upCodec === 1, 'the walkie on ADPCM again');
});

test('AUDIO_UP that arrives as ADPCM reaches listeners as PCM16 of 640 bytes a frame, with EOS and the codec bits gone', async (t) => {
  const { device, seen } = await connect(t, { s3: { adpcm: true }, link: { adpcm: true } });
  await until(() => device.upCodec === 1, 'SET_CODEC 1');
  const pcm = tone(1600, 500, 16000); // 100 ms: five frames
  device.take(pcm);
  await until(() => seen['audio-up'].length === 5, 'five AUDIO_UP frames');
  const got = seen['audio-up'];
  assert.ok(got.every((f) => f.payload.length === 640 && (f.flags & 0x06) === 0));
  assert.deepEqual(got.map((f) => f.flags & 1), [0, 0, 0, 0, 1]);
  assert.equal(Buffer.concat(got.map((f) => f.payload)).compare(playedFor(pcm, 640)), 0, 'the PCM the reference decoder gives');
  device.feed(TYPE.AUDIO_UP, Buffer.alloc(0), 0x01 | 0x02); // a take ended by an empty EOS frame, whatever codec it says
  await until(() => seen['audio-up'].length === 6, 'the empty EOS frame');
  assert.equal(seen['audio-up'][5].payload.length, 0);
  assert.equal(seen['audio-up'][5].flags & 0x06, 0);
});

test('AUDIO_UP is untouched while the walkie is still on PCM16', async (t) => {
  const { device, seen } = await connect(t, { s3: { adpcm: true } });
  const pcm = tone(640, 500, 16000);
  device.take(pcm);
  await until(() => seen['audio-up'].length === 2, 'two frames');
  assert.equal(Buffer.concat(seen['audio-up'].map((f) => f.payload)).compare(pcm), 0);
});

test('an AUDIO_UP frame that is no good is dropped and counted, and the link says so once', async (t) => {
  const { device, link, seen } = await connect(t, { s3: { adpcm: true }, link: { adpcm: true } });
  device.feed(TYPE.AUDIO_UP, Buffer.from([0, 0, 99, 0, 1, 2]), 0x02); // step index 99
  device.feed(TYPE.AUDIO_UP, Buffer.from([0, 0, 0]), 0x02); // shorter than its header
  device.feed(TYPE.AUDIO_UP, Buffer.from([0, 0, 0, 0, 1, 2]), 0x04); // codec 2 is reserved
  await settle();
  await settle();
  assert.equal(seen['audio-up'].length, 0);
  assert.equal(link.badAudioFrames, 3);
  assert.equal(seen.status.filter((s) => /AUDIO_UP/.test(s)).length, 1, JSON.stringify(seen.status));
});
