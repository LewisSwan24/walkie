// The payloads of UI, APPROVAL_REQ and TEST that the screens and the test hooks use: what they hold at most, and what a
// reader makes of a payload that is not what the writer would have sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS, UI_STATE, clipUtf8, uiPayload, approvalReqPayload, testKeysPayload, testMicPcmPayload,
  parseUi, parseApprovalReq, parseTestKeys,
} from '../../src/link/messages.js';

test('text that fits is left alone, and text that does not is cut on a character with an ellipsis', () => {
  assert.equal(clipUtf8('你好', 6), '你好');
  assert.equal(clipUtf8('你好吗', 6), '你…'); // 3 bytes of room for text, 3 for the ellipsis
  assert.equal(clipUtf8('', 5), '');
  assert.equal(clipUtf8(undefined, 5), '');
  const long = '嗯'.repeat(2000);
  const cut = clipUtf8(long, LIMITS.text);
  assert.ok(Buffer.byteLength(cut) <= LIMITS.text);
  assert.equal(cut, `${'嗯'.repeat(299)}…`);
});

test('a character of four bytes is never split', () => {
  const faces = '😀'.repeat(300); // 4 bytes each, a surrogate pair in JavaScript
  const cut = clipUtf8(faces, 10);
  assert.equal(cut, '😀…'); // 4 + 3 = 7 bytes; a second face would make 11
  assert.equal(Buffer.from(cut).toString('utf8'), cut, 'it survives the trip through UTF-8');
});

test('a UI frame with every field at its limit still fits in one frame', () => {
  const p = uiPayload({ state: UI_STATE.WORKING, project: 'p'.repeat(500), text: '字'.repeat(2000), elapsedMs: 0xffffffff });
  assert.ok(p.length <= 1024, `${p.length} bytes`);
  const view = parseUi(p);
  assert.equal(view.project.length, LIMITS.project - 3 + 1);
  assert.ok(view.text.endsWith('…') && Buffer.byteLength(view.text) <= LIMITS.text);
  assert.equal(view.elapsedMs, 0xffffffff);
});

test('empty fields are left out, so a bare state is one byte', () => {
  assert.equal(uiPayload({ state: UI_STATE.TRANSCRIBING }).toString('hex'), '01');
  assert.equal(uiPayload({ state: UI_STATE.IDLE, project: '', text: '' }).toString('hex'), '00');
  assert.deepEqual(parseUi(Buffer.from([1])), { state: 1 });
});

test('a state or a time the S3 would misread is refused', () => {
  for (const state of [-1, 6, 1.5, undefined, '3']) assert.throws(() => uiPayload({ state }), RangeError, `state ${state}`);
  for (const elapsedMs of [-1, 2 ** 32, 1.5]) assert.throws(() => uiPayload({ state: 3, elapsedMs }), RangeError, `elapsed ${elapsedMs}`);
});

test('an approval request with the longest tool and preview still fits in one frame', () => {
  const p = approvalReqPayload({ id: 65535, tool: 'T'.repeat(200), preview: '改'.repeat(1000) });
  assert.ok(p.length <= 1024, `${p.length} bytes`);
  const req = parseApprovalReq(p);
  assert.equal(req.id, 65535);
  assert.equal(req.tool, 'T'.repeat(LIMITS.tool - 3) + '…');
  assert.ok(req.preview.endsWith('…') && Buffer.byteLength(req.preview) <= LIMITS.preview);
});

test('an approval id outside 16 bits is refused', () => {
  for (const id of [-1, 65536, 1.5, undefined]) assert.throws(() => approvalReqPayload({ id, tool: 'Bash', preview: '' }), RangeError, `id ${id}`);
});

test('a key script of nothing, of too many steps, or with a key that does not exist is refused', () => {
  assert.throws(() => testKeysPayload([]), RangeError);
  assert.throws(() => testKeysPayload(Array.from({ length: 17 }, () => ({ delayMs: 0, mask: 0 }))), RangeError);
  assert.throws(() => testKeysPayload([{ delayMs: 0, mask: 4 }]), RangeError);
  assert.throws(() => testKeysPayload([{ delayMs: 65536, mask: 1 }]), RangeError);
  assert.throws(() => testKeysPayload([{ delayMs: -1, mask: 1 }]), RangeError);
  assert.equal(testKeysPayload(Array.from({ length: 16 }, () => ({ delayMs: 65535, mask: 3 }))).length, 2 + 16 * 3);
});

test('mic PCM that is empty, odd or longer than one frame can carry is refused', () => {
  assert.throws(() => testMicPcmPayload(Buffer.alloc(0)), RangeError);
  assert.throws(() => testMicPcmPayload(Buffer.alloc(3)), RangeError);
  assert.throws(() => testMicPcmPayload(Buffer.alloc(1002)), RangeError);
  assert.throws(() => testMicPcmPayload('abcd'), RangeError);
  assert.equal(testMicPcmPayload(Buffer.alloc(1000)).length, 1001);
});

test('a reader skips a field it does not know and refuses a payload that is cut short', () => {
  const unknown = Buffer.from([2, 9, 2, 0, 0xaa, 0xbb, 1, 2, 0, 0x68, 0x69]); // CONFIRM, tag 9 (2 bytes), tag 1 "hi"
  assert.deepEqual(parseUi(unknown), { state: 2, project: 'hi' });
  assert.equal(parseUi(Buffer.from([2, 1, 5, 0, 0x68])), null, 'a field that runs past the end');
  assert.equal(parseUi(Buffer.from([2, 1, 5])), null, 'a field header that runs past the end');
  assert.equal(parseUi(Buffer.alloc(0)), null);
  assert.equal(parseUi(Buffer.from([6])), null, 'a state that does not exist');
  assert.deepEqual(parseUi(Buffer.from([3, 3, 2, 0, 1, 2])), { state: 3 }, 'a time that is not 4 bytes is ignored');
  assert.equal(parseApprovalReq(Buffer.from([1, 0, 9, 0x61])), null, 'a tool name longer than the payload');
  assert.equal(parseTestKeys(Buffer.from([2, 2, 0, 0, 1])), null, 'two steps announced, one sent');
  assert.equal(parseTestKeys(Buffer.from([2, 0])), null);
});
