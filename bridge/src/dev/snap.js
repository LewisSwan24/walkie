// snap [--out file.png]: what the S3's screen shows right now, as a PNG. The firmware reads its own display back (TEST SNAP) and
// sends it in chunks of a few rows; this puts them together. Without --out the file goes to bridge/snaps/ with the time in its
// name. ui and press take --snap file.png to look at the screen they have just changed: the screen only lasts while a bridge
// is pinging, so another process could not.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TYPE } from '../link/frame.js';
import { parseSnapChunk, testSnapPayload } from '../link/messages.js';
import { connect } from './connect.js';
import { encodePng } from './png.js';

const DEFAULT_DIR = fileURLToPath(new URL('../../snaps/', import.meta.url));
const SNAP_TIMEOUT_MS = 3000; // a whole snapshot takes about a second
const SNAP_ATTEMPTS = 3;

// Five-bit and six-bit channels spread over 0..255 (the top bits repeated in the bottom), so that full is 255 and not 248.
const spread5 = (v) => (v << 3) | (v >> 2);
const spread6 = (v) => (v << 2) | (v >> 4);

// chunks: the parsed TEST SNAP frames (parseSnapChunk), in any order. -> {width, height, rgb} with 8-bit RGB.
export function assembleSnap(chunks) {
  if (chunks.length === 0) throw new Error('the snapshot has no chunks');
  const { count, width, height } = chunks[0];
  if (!(width >= 1 && height >= 1 && count >= 1)) throw new Error(`the snapshot is ${width}x${height} in ${count} chunks: not a size`);
  const byIndex = new Map();
  for (const c of chunks) {
    if (c.count !== count) throw new Error(`the snapshot's chunk count changed from ${count} to ${c.count}`);
    if (c.width !== width || c.height !== height) throw new Error(`the snapshot's size changed from ${width}x${height} to ${c.width}x${c.height}`);
    if (c.index >= count) throw new Error(`a chunk has index ${c.index} in a snapshot of ${count} chunks`);
    if (byIndex.has(c.index)) throw new Error(`chunk ${c.index} came twice`);
    byIndex.set(c.index, c.pixels);
  }
  if (byIndex.size !== count) throw new Error(`the snapshot has ${byIndex.size} of ${count} chunks`);
  const rgb565 = Buffer.concat(Array.from({ length: count }, (_, i) => byIndex.get(i)));
  if (rgb565.length !== width * height * 2) throw new Error(`the snapshot has ${rgb565.length} pixel bytes, a ${width}x${height} screen is ${width * height * 2}`);
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const px = rgb565.readUInt16LE(i * 2);
    rgb[i * 3] = spread5(px >> 11);
    rgb[i * 3 + 1] = spread6((px >> 5) & 0x3f);
    rgb[i * 3 + 2] = spread5(px & 0x1f);
  }
  return { width, height, rgb };
}

// One request for the screen, and a wait for all of it. A timeout rejects with `timedOut` set.
function takeSnapOnce(link, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let timer = null;
    const finish = (settle, value) => {
      clearTimeout(timer);
      link.off('frame', onFrame);
      settle(value);
    };
    function onFrame(f) {
      if (f.type !== TYPE.TEST) return;
      const chunk = parseSnapChunk(f.payload);
      if (!chunk) return;
      chunks.push(chunk);
      if (chunks.length < chunk.count) return;
      try {
        finish(resolve, assembleSnap(chunks));
      } catch (err) {
        finish(reject, err);
      }
    }
    timer = setTimeout(() => {
      const of = chunks.length > 0 ? ` of ${chunks[0].count}` : '';
      finish(reject, Object.assign(new Error(`the S3 sent ${chunks.length}${of} snapshot chunks within ${timeoutMs / 1000} s`), { timedOut: true }));
    }, timeoutMs);
    link.on('frame', onFrame);
    link.send(TYPE.TEST, testSnapPayload());
  });
}

// Asks for the screen and waits for all of it. A chunk that went missing on the way (at gate H about one snapshot in twenty lost
// one to a frame that arrived damaged) is not waited for any longer: the screen is asked for again, `attempts` times in all. The
// error of the last try is the one that is thrown; a screen that arrived whole but wrong is thrown at once.
export async function takeSnap(link, { timeoutMs = SNAP_TIMEOUT_MS, attempts = SNAP_ATTEMPTS } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await takeSnapOnce(link, timeoutMs);
    } catch (err) {
      if (!err.timedOut || attempt >= attempts) throw err;
    }
  }
}

// The screen, written to `file` as a PNG; resolves the file.
export async function snapTo(link, file, options) {
  const { width, height, rgb } = await takeSnap(link, options);
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  writeFileSync(file, encodePng(width, height, rgb));
  console.log(`snap: ${width}x${height} -> ${file}`);
  return file;
}

// connectFn and `options` ({timeoutMs, dir}) are for tests.
export default async function snap(args, opts, connectFn = connect, { timeoutMs, dir = DEFAULT_DIR } = {}) {
  const file = opts.out ?? path.join(dir, `snap-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
  const link = await connectFn(opts);
  try {
    await snapTo(link, file, { timeoutMs });
  } finally {
    link.close();
  }
}
