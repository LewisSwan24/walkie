import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import snap, { assembleSnap, snapTo, takeSnap } from '../../src/dev/snap.js';
import { TYPE } from '../../src/link/frame.js';
import { TEST_OP, parseSnapChunk } from '../../src/link/messages.js';
import { fakeLink, fakeLinkWithScreen, frameOf, snapFrames } from '../helpers/fake-link.js';

const RED = 0xf800;
const GREEN = 0x07e0;
const BLUE = 0x001f;
const GREY = 0x8410; // r 16, g 32, b 16: the fives and the six must be spread over 0..255, not shifted

const chunksOf = (frames) => frames.map((f) => parseSnapChunk(f.payload));
const pngSize = (file) => {
  const png = readFileSync(file);
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
};

test('RGB565 pixels become RGB with the low bits spread, so white is white and black is black', () => {
  const colours = [0x0000, 0xffff, RED, GREEN, BLUE, GREY];
  const { width, height, rgb } = assembleSnap(chunksOf(snapFrames(6, 1, (x) => colours[x])));
  assert.deepEqual([width, height], [6, 1]);
  assert.deepEqual([...rgb], [0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255, 132, 130, 132]);
});

test('chunks that arrive out of order still make the screen in order', () => {
  const chunks = chunksOf(snapFrames(2, 5, (x, y) => (y < 2 ? RED : y < 4 ? GREEN : BLUE))).reverse();
  assert.equal(chunks.length, 3);
  const { rgb } = assembleSnap(chunks);
  assert.deepEqual([...rgb.subarray(0, 3)], [255, 0, 0]);
  assert.deepEqual([...rgb.subarray(2 * 2 * 3, 2 * 2 * 3 + 3)], [0, 255, 0]);
  assert.deepEqual([...rgb.subarray(4 * 2 * 3, 4 * 2 * 3 + 3)], [0, 0, 255], 'the one-row last chunk');
});

test('a snapshot that is not whole is refused, and says why', () => {
  const whole = chunksOf(snapFrames(4, 6, () => RED));
  assert.throws(() => assembleSnap([]), /no chunks/);
  assert.throws(() => assembleSnap(whole.slice(1)), /2 of 3 chunks/);
  assert.throws(() => assembleSnap([...whole, whole[0]]), /chunk 0 came twice/);
  assert.throws(() => assembleSnap([whole[0], { ...whole[1], width: 5 }, whole[2]]), /size changed/);
  assert.throws(() => assembleSnap([whole[0], { ...whole[1], count: 4 }, whole[2]]), /count changed/);
  assert.throws(() => assembleSnap([whole[0], { ...whole[1], index: 3 }, whole[2]]), /index 3 .* 3 chunks/);
  assert.throws(() => assembleSnap([whole[0], { ...whole[1], pixels: whole[1].pixels.subarray(2) }, whole[2]]), /pixel bytes/);
  assert.throws(() => assembleSnap(chunksOf(snapFrames(4, 6, () => RED)).map((c) => ({ ...c, width: 0 }))), /size/);
});

test('takeSnap asks for the screen and returns it when the last chunk is in', async () => {
  const link = fakeLinkWithScreen(8, 4, (x) => (x < 4 ? RED : BLUE));
  const shot = await takeSnap(link);
  assert.equal(link.sent.length, 1);
  assert.equal(link.sent[0].type, TYPE.TEST);
  assert.deepEqual([...link.sent[0].payload], [TEST_OP.SNAP]);
  assert.deepEqual([shot.width, shot.height], [8, 4]);
  assert.deepEqual([...shot.rgb.subarray(0, 3)], [255, 0, 0]);
  assert.deepEqual([...shot.rgb.subarray(7 * 3, 7 * 3 + 3)], [0, 0, 255]);
  assert.equal(link.listenerCount('frame'), 0, 'it stops listening');
});

test('frames that are not chunks of the screen are not counted', async () => {
  const link = fakeLink();
  link.onSend = () => {
    link.emit('frame', frameOf(TYPE.BUTTON, Buffer.from([1])));
    link.emit('frame', frameOf(TYPE.APPROVAL_RES, snapFrames(2, 2, () => BLUE)[0].payload)); // the right bytes, from the wrong kind of frame
    link.emit('frame', frameOf(TYPE.TEST, Buffer.from([TEST_OP.UP_PATTERN, 1, 2, 3])));
    for (const f of snapFrames(2, 2, () => RED)) link.emit('frame', f);
  };
  const shot = await takeSnap(link);
  assert.deepEqual([shot.width, shot.height], [2, 2]);
  assert.deepEqual([...shot.rgb.subarray(0, 3)], [255, 0, 0]);
});

test('a snapshot that does not come is an error that says how much did', async () => {
  const link = fakeLink();
  link.onSend = () => link.emit('frame', snapFrames(2, 6, () => RED)[0]);
  await assert.rejects(takeSnap(link, { timeoutMs: 30 }), /1 of 3 snapshot chunks within 0\.03 s/);
  assert.equal(link.listenerCount('frame'), 0);
  const silent = fakeLink();
  await assert.rejects(takeSnap(silent, { timeoutMs: 30 }), /0 snapshot chunks/);
});

test('a snapshot that is whole but wrong rejects instead of hanging', async () => {
  const link = fakeLink();
  link.onSend = () => {
    for (const f of snapFrames(4, 4, () => RED)) {
      f.payload.writeUInt16LE(9, 5); // a width the pixels do not make
      link.emit('frame', f);
    }
  };
  await assert.rejects(takeSnap(link, { timeoutMs: 1000 }), /pixel bytes/);
});

test('snapTo writes the screen as a PNG of the right size, in a folder that did not exist', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'walkie-snap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const link = fakeLinkWithScreen(240, 135, () => GREEN);
  const file = path.join(dir, 'a', 'b', 'screen.png');
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  assert.equal(await snapTo(link, file), file);
  assert.deepEqual(pngSize(file), [240, 135]);
  assert.match(lines.join('\n'), /snap: 240x135 -> /);
});

test('the snap command saves to --out, or to a stamped file in the default folder, and closes the link', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'walkie-snap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.mock.method(console, 'log', () => {});
  const link = fakeLinkWithScreen(10, 4, () => RED);
  await snap([], { out: path.join(dir, 'x.png') }, async () => link, { dir: path.join(dir, 'unused') });
  assert.deepEqual(pngSize(path.join(dir, 'x.png')), [10, 4]);
  assert.equal(link.closed, true);
  assert.deepEqual(readdirSync(dir), ['x.png'], 'the default folder was not touched');

  const stamped = fakeLinkWithScreen(10, 4, () => BLUE);
  await snap([], {}, async () => stamped, { dir: path.join(dir, 'snaps') });
  const [name, ...others] = readdirSync(path.join(dir, 'snaps'));
  assert.match(name, /^snap-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.png$/);
  assert.deepEqual(others, []);
  assert.equal(stamped.closed, true);
});

test('snap closes the link when the snapshot fails', async (t) => {
  t.mock.method(console, 'log', () => {});
  const link = fakeLink();
  await assert.rejects(snap([], { out: path.join(tmpdir(), 'never.png') }, async () => link, { timeoutMs: 20 }), /snapshot chunks/);
  assert.equal(link.closed, true);
});

test('a snapshot that arrived does not leave its timeout running', async (t) => {
  const cleared = [];
  const clear = globalThis.clearTimeout;
  t.mock.method(globalThis, 'clearTimeout', (id) => {
    cleared.push(id);
    clear(id);
  });
  await takeSnap(fakeLinkWithScreen(2, 2, () => RED), { timeoutMs: 2000 });
  assert.equal(cleared.length, 1);
});

// ---- a chunk lost on the way: at gate H about one snapshot in twenty lost one to a frame that arrived damaged -------------------

// A link that answers the n-th request with the screen minus the chunks whose indexes are in lost[n] (all of it once the list is used up).
function lossyLink(lost) {
  const link = fakeLink();
  let request = 0;
  link.onSend = () => {
    const drop = lost[request++] ?? [];
    for (const f of snapFrames(8, 8, () => GREEN)) {
      if (!drop.includes(parseSnapChunk(f.payload).index)) link.emit('frame', f);
    }
  };
  return link;
}

test('a chunk lost on the way is not the end of the picture: the screen is asked for again', async () => {
  const link = lossyLink([[2]]);
  const shot = await takeSnap(link, { timeoutMs: 50 });
  assert.equal(link.sent.length, 2);
  assert.deepEqual([shot.width, shot.height], [8, 8]);
  assert.deepEqual([...shot.rgb.subarray(0, 3)], [0, 255, 0]);
  assert.equal(link.listenerCount('frame'), 0);
});

test('a screen that never comes whole is asked for three times, and then the error says how much came', async () => {
  const link = lossyLink([[1], [1], [1], [1]]);
  await assert.rejects(takeSnap(link, { timeoutMs: 20 }), /3 of 4 snapshot chunks within 0\.02 s/);
  assert.equal(link.sent.length, 3);
  assert.equal(link.listenerCount('frame'), 0);
});

test('attempts says how many times to ask', async () => {
  const once = lossyLink([[0], [0]]);
  await assert.rejects(takeSnap(once, { timeoutMs: 20, attempts: 1 }), /3 of 4/);
  assert.equal(once.sent.length, 1);
  const thrice = lossyLink([[0], [0], []]);
  await takeSnap(thrice, { timeoutMs: 20, attempts: 3 });
  assert.equal(thrice.sent.length, 3);
});

test('a screen that arrived whole but wrong is an error at once, not a reason to ask again', async () => {
  const link = fakeLink();
  link.onSend = () => {
    for (const f of snapFrames(4, 4, () => RED)) {
      f.payload.writeUInt16LE(9, 5);
      link.emit('frame', f);
    }
  };
  await assert.rejects(takeSnap(link, { timeoutMs: 1000 }), /pixel bytes/);
  assert.equal(link.sent.length, 1);
});

test('snapTo asks again for a lost chunk too, and writes the picture', async (t) => {
  t.mock.method(console, 'log', () => {});
  const dir = mkdtempSync(path.join(tmpdir(), 'walkie-snap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const link = lossyLink([[3]]);
  const file = await snapTo(link, path.join(dir, 'lossy.png'), { timeoutMs: 50 });
  assert.deepEqual(pngSize(file), [8, 8]);
  assert.equal(link.sent.length, 2);
});
