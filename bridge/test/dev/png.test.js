import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, inflateSync } from 'node:zlib';
import { encodePng } from '../../src/dev/png.js';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// A reader that trusts nothing: the signature, every chunk's CRC, the header, and the rows with their filter byte.
function decode(png) {
  assert.deepEqual(png.subarray(0, 8), SIGNATURE);
  const chunks = [];
  for (let at = 8; at < png.length; ) {
    const len = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + len);
    assert.equal(png.readUInt32BE(at + 8 + len), crc32(png.subarray(at + 4, at + 8 + len)), `${type} CRC`);
    chunks.push({ type, data });
    at += 12 + len;
  }
  assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
  const ihdr = chunks[0].data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  assert.deepEqual([...ihdr.subarray(8)], [8, 2, 0, 0, 0], '8 bits, truecolour, no interlace');
  const raw = inflateSync(chunks[1].data);
  assert.equal(raw.length, height * (1 + width * 3));
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (1 + width * 3)], 0, 'filter none');
    raw.copy(rgb, y * width * 3, y * (1 + width * 3) + 1, (y + 1) * (1 + width * 3));
  }
  return { width, height, rgb };
}

test('a PNG that is read back has the size and the pixels it was given', () => {
  const rgb = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
  const out = decode(encodePng(3, 2, rgb));
  assert.equal(out.width, 3);
  assert.equal(out.height, 2);
  assert.deepEqual(out.rgb, rgb);
});

test('the size of the S3 screen goes through, and a big flat one is small', () => {
  const rgb = Buffer.alloc(240 * 135 * 3, 0x20);
  const png = encodePng(240, 135, rgb);
  const out = decode(png);
  assert.deepEqual([out.width, out.height], [240, 135]);
  assert.deepEqual(out.rgb, rgb);
  assert.ok(png.length < 1000, `deflated: ${png.length} bytes`);
});

test('pixels that do not fit the size are refused, not padded', () => {
  assert.throws(() => encodePng(2, 2, Buffer.alloc(11)), /12 bytes/);
  assert.throws(() => encodePng(0, 2, Buffer.alloc(0)), /size/);
});
