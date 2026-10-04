// A PNG from 8-bit RGB pixels, with nothing but zlib: the screen of the S3 as a picture that can be opened and looked at.
import { crc32, deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, crc]);
}

// rgb: width * height * 3 bytes, row by row.
export function encodePng(width, height, rgb) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new RangeError(`PNG size must be positive integers, not ${width}x${height}`);
  if (rgb.length !== width * height * 3) throw new RangeError(`a ${width}x${height} PNG is ${width * height * 3} bytes of RGB, not ${rgb.length}`);
  const row = width * 3;
  const raw = Buffer.alloc(height * (1 + row)); // each row starts with its filter byte, 0 = none
  for (let y = 0; y < height; y++) rgb.copy(raw, y * (1 + row) + 1, y * row, (y + 1) * row);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8 bits, truecolour, deflate, no filter, no interlace
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
