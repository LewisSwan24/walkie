import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMadeByWriteFlashArgs, writeFlashArgs } from '../lib/writeflash.mjs';
import { esptool } from '../lib/esptool.mjs';

let dir;
const file = (name, buf) => {
  const p = path.join(dir, name);
  writeFileSync(p, buf);
  return p;
};
// A minimal ESP32-S3 app image header: magic 0xE9 at byte 0, chip id 9 at byte 12, padded to 4 KB.
const appImage = ({ magic = 0xe9, chip = 9, size = 4096 } = {}) => {
  const b = Buffer.alloc(size);
  b[0] = magic;
  b.writeUInt16LE(chip, 12);
  return b;
};

before(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'walkie-writeflash-')); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

test('app1 plus otadata gives the argv esptool will run, and only that array is trusted', () => {
  const app = file('app.bin', appImage());
  const ota = file('ota.bin', Buffer.alloc(0x2000, 0xff));
  const argv = writeFlashArgs([{ addr: 0x340000, file: app }, { addr: 0xe000, file: ota }]);
  assert.deepEqual(argv.slice(-5), ['write_flash', '0x340000', app, '0xe000', ota]);
  assert.equal(isMadeByWriteFlashArgs(argv), true);
  assert.equal(isMadeByWriteFlashArgs([...argv]), false);
});

test('writes outside app1 and otadata, or of the wrong size or kind, are refused', () => {
  const app = file('app.bin', appImage());
  const big = file('big.bin', appImage({ size: 0x330001 }));
  const shortOta = file('short-ota.bin', Buffer.alloc(0x1000, 0xff));
  const notEsp = file('not-esp.bin', appImage({ magic: 0x00 }));
  const esp32 = file('esp32.bin', appImage({ chip: 5 }));
  for (const w of [
    { addr: 0x10000, file: app },
    { addr: 0x340000, file: big },
    { addr: 0xe000, file: shortOta },
    { addr: 0x340000, file: notEsp },
    { addr: 0x340000, file: esp32 },
  ]) {
    assert.throws(() => writeFlashArgs([w]), undefined, JSON.stringify(w));
  }
});

// COM99 does not exist: if the guard were broken, esptool would fail to open the port instead of writing the S3.
test('esptool refuses anything writeFlashArgs did not build', () => {
  const readOnly = ['--before', 'default_reset', '--after', 'hard_reset', 'read_flash', '0x8000', '0xc00', path.join(dir, 'p.bin')];
  assert.throws(() => esptool('COM99', ['--before', 'default_reset', '--after', 'hard_reset', 'write_flash', '0x10000', 'x']), /refusing/);
  assert.throws(() => esptool('/dev/ttyUSB0', readOnly), /refusing/);
  assert.throws(() => esptool('COM99', ['erase_flash']), /refusing/);
});
