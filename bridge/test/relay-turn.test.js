// The whole bridge with the S3 on the far side of a real relay instead of a cable: the same turns as in main.test.js, sealed and plain,
// and the two ways a network differs from USB: the S3 leaves and comes back, and the relay itself goes away and comes back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRelay } from '../../relay/src/server.js';
import { Link } from '../src/link/link.js';
import { TYPE } from '../src/link/frame.js';
import { UI_STATE } from '../src/link/messages.js';
import { FakeS3, until } from './helpers/fake-s3.js';
import { relayedS3 } from './helpers/relay-s3.js';
import { speechPcm, world } from './helpers/world.js';

const KEY = Buffer.alloc(32, 0x42);
const FAST = { pingEveryMs: 100, pongTimeoutMs: 400 };

test('over the relay, a spoken request goes through the screens, to Claude, and its reply is shown and spoken on the S3', async (t) => {
  const w = await world(t, { said: ['你好'], relay: true });
  assert.equal(w.bridge.link.ready, true);
  w.s3.take(speechPcm);
  await until(() => w.s3.screens().some((s) => s.state === UI_STATE.REPLY), 'the REPLY screen');
  assert.deepEqual(w.order(), [UI_STATE.IDLE, UI_STATE.TRANSCRIBING, UI_STATE.CONFIRM, UI_STATE.WORKING, UI_STATE.REPLY]);
  assert.match(w.shown(UI_STATE.REPLY).text, /I heard: 你好/);
  await until(() => w.s3.audioDown().ended, 'the spoken reply to reach the S3');
  assert.ok(w.s3.audioDown().bytes > 0);
  assert.equal(w.s3.badDown, 0);
});

test('over the relay, a tool call that needs approval is shown on the S3, and the key that allows it lets Claude go on', async (t) => {
  const w = await world(t, { said: ['!write note.txt'], relay: true });
  w.s3.take(speechPcm);
  await until(() => w.s3.frames(TYPE.APPROVAL_REQ).length === 1, 'the approval on the S3');
  const shown = w.s3.screens().find((s) => s.approval).approval;
  w.s3.answer(shown.id, true);
  await until(() => w.s3.screens().some((s) => s.text === 'Created note.txt.'), 'Claude to go on');
});

test('over the relay, with the pairing key and ADPCM, a whole turn runs sealed, and the room is the one the key names', async (t) => {
  const w = await world(t, { said: ['你好'], relay: true, s3: { proto: 2, master: KEY, adpcm: true }, link: { master: KEY, adpcm: true } });
  await until(() => w.s3.upCodec === 1, 'the S3 asked for ADPCM takes');
  w.s3.take(speechPcm);
  await until(() => w.s3.screens().some((s) => s.state === UI_STATE.REPLY), 'the REPLY screen');
  await until(() => w.s3.audioDown().ended, 'the spoken reply to reach the S3');
  assert.ok(w.s3.raw.filter((f) => f.type !== TYPE.HELLO).every((f) => f.flags & 0x80), 'every frame after HELLO was sealed');
  assert.equal(w.s3.refused.length, 0);
  assert.ok(w.s3.frames(TYPE.AUDIO_DOWN).every((f) => !f.payload.length || (f.flags & 0x06) === 0x02), 'the reply went down as ADPCM');
  assert.match(w.relayed.room, /^[0-9a-f]{32}$/);
  assert.notEqual(w.relayed.room, 'd'.repeat(32), 'a paired link is not in the test room');
});

// A Link on the relay with the fast clock, and what it said.
async function linkOnRelay(t, { master = null, s3Options = {}, relay = null } = {}) {
  const s3 = new FakeS3(s3Options);
  const relayed = await relayedS3(t, s3, { master, clock: FAST, relay });
  const link = new Link({ openPort: relayed.openPort, master, makeNonce: () => 9, retryMs: 50, retryMaxMs: 200 });
  const seen = { down: [], hello: [] };
  link.on('down', (r) => seen.down.push(r));
  link.on('hello', (h) => seen.hello.push(h));
  t.after(() => link.close());
  await link.start();
  await until(() => link.ready, 'the link to be ready');
  return { s3, relayed, link, seen };
}

test('the S3 leaves the room and comes back: the link says it lost the S3, and is ready again when it is back, sealed as before', async (t) => {
  const { s3, relayed, link, seen } = await linkOnRelay(t, { master: KEY, s3Options: { proto: 2, master: KEY } });
  relayed.unplug();
  await until(() => !link.ready, 'the link to notice the S3 is gone');
  assert.match(seen.down[0], /^no PONG for 0\.4 s$/);
  await relayed.plug();
  await until(() => link.ready, 'the link to be ready again');
  const before = s3.sent.length;
  link.send(TYPE.PING, Buffer.alloc(8));
  await until(() => s3.sent.length > before, 'a frame to reach the S3 again');
  assert.equal(s3.refused.length, 0, 'and the S3 opened everything it was sent');
});

test('the relay goes away and comes back: the link, and the S3, find their way back by themselves', async (t) => {
  const relay = await startRelay({ port: 0, host: '127.0.0.1', pingEveryMs: 60_000 });
  const { link, seen, relayed } = await linkOnRelay(t, { relay });
  const port = relay.port;
  await relay.close();
  await until(() => !link.ready && !relayed.joined, 'both ends to notice');
  assert.equal(seen.down.length, 1);
  const back = await startRelay({ port, host: '127.0.0.1', pingEveryMs: 60_000 });
  t.after(() => back.close());
  await until(() => link.ready, 'the link to be ready through the relay that came back');
  assert.equal(relayed.joined, true);
});

test('a relay with nobody in the room is no S3: the link opens, is not ready, and says nothing is wrong with the relay', async (t) => {
  const s3 = new FakeS3();
  const relayed = await relayedS3(t, s3, { clock: FAST });
  relayed.unplug();
  const link = new Link({ openPort: relayed.openPort, makeNonce: () => 9 });
  const status = [];
  link.on('status', (s) => status.push(s));
  t.after(() => link.close());
  await link.start();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(link.ready, false);
  assert.deepEqual(status, [], 'the port opened, so there is nothing to report but silence');
  await relayed.plug();
  await until(() => link.ready, 'the S3 arriving later is found by the next HELLO');
});
