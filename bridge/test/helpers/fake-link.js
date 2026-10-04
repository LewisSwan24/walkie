// A stand-in for the Link that the dev commands are given: it records what is sent, and the test emits what the S3 would say.
import { EventEmitter } from 'node:events';
import { TYPE } from '../../src/link/frame.js';
import { TEST_OP } from '../../src/link/messages.js';

export function fakeLink() {
  const link = new EventEmitter();
  link.sent = [];
  link.closed = false;
  link.onSend = null; // (type, payload) => void, to answer at once
  link.send = (type, payload = Buffer.alloc(0), flags = 0) => {
    link.sent.push({ type, payload, flags });
    link.onSend?.(type, payload);
    return true;
  };
  link.close = () => {
    link.closed = true;
  };
  return link;
}

export const frameOf = (type, payload) => ({ type, flags: 0, seq: 0, payload });

// What the S3 answers TEST SNAP with: the screen as RGB565 little endian, `rowsPerChunk` rows to a chunk.
// `pixelAt(x, y)` is the 16-bit colour of a pixel.
export function snapFrames(width, height, pixelAt, rowsPerChunk = 2) {
  const count = Math.ceil(height / rowsPerChunk);
  return Array.from({ length: count }, (_, index) => {
    const rows = Math.min(rowsPerChunk, height - index * rowsPerChunk);
    const pixels = Buffer.alloc(rows * width * 2);
    for (let r = 0; r < rows; r++) {
      for (let x = 0; x < width; x++) pixels.writeUInt16LE(pixelAt(x, index * rowsPerChunk + r), (r * width + x) * 2);
    }
    const head = Buffer.alloc(9);
    head[0] = TEST_OP.SNAP;
    head.writeUInt16LE(index, 1);
    head.writeUInt16LE(count, 3);
    head.writeUInt16LE(width, 5);
    head.writeUInt16LE(height, 7);
    return frameOf(TYPE.TEST, Buffer.concat([head, pixels]));
  });
}

// A link that answers TEST SNAP with a screen of `pixelAt`.
export function fakeLinkWithScreen(width, height, pixelAt) {
  const link = fakeLink();
  link.onSend = (type, payload) => {
    if (type === TYPE.TEST && payload[0] === TEST_OP.SNAP) {
      for (const f of snapFrames(width, height, pixelAt)) link.emit('frame', f);
    }
  };
  return link;
}
