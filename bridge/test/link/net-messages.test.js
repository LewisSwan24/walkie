// NET (protocol/frames.md, "Network settings (plan 6)"): the PC sets the S3's Wi-Fi networks and relay host over a sealed link.
// The hex strings here are the same ones firmware/host/test_net_messages.cpp checks, so the two ends cannot drift apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TYPE } from '../../src/link/frame.js';
import {
  NET_OP,
  NET_ERR,
  NET_LIMITS,
  netWifiAddPayload,
  netWifiRemovePayload,
  netWifiListPayload,
  netRelaySetPayload,
  netRelayClearPayload,
  parseNetReply,
} from '../../src/link/messages.js';

const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (s) => Buffer.from(s, 'hex');

test('the NET frame type and its ops are the ones the S3 uses', () => {
  assert.equal(TYPE.NET, 0x33);
  assert.deepEqual({ ...NET_OP }, { WIFI_ADD: 1, WIFI_REMOVE: 2, WIFI_LIST: 3, RELAY_SET: 4, RELAY_CLEAR: 5, OK: 0x80, ERR: 0x81, LIST: 0x82 });
  assert.deepEqual({ ...NET_ERR }, { BAD: 1, FULL: 2, UNKNOWN: 3, STORE: 4 });
  assert.deepEqual({ ...NET_LIMITS }, { ssid: 32, pass: 63, host: 63, networks: 4 });
});

test('requests are laid out as the S3 parses them', () => {
  assert.equal(hex(netWifiAddPayload('home', 'secret123')), '0104686f6d6509736563726574313233');
  assert.equal(hex(netWifiAddPayload('cafe', '')), '01046361666500');
  assert.equal(hex(netWifiRemovePayload('home')), '0204686f6d65');
  assert.equal(hex(netWifiListPayload()), '03');
  assert.equal(hex(netRelaySetPayload('walkie-relay.fly.dev')), '041477616c6b69652d72656c61792e666c792e646576');
  assert.equal(hex(netRelayClearPayload()), '05');
});

test('an SSID is counted in UTF-8 bytes, not characters', () => {
  const p = netWifiAddPayload('咖啡', 'password1');
  assert.equal(p[1], 6);
  assert.equal(p.subarray(2, 8).toString('utf8'), '咖啡');
  assert.throws(() => netWifiAddPayload('咖'.repeat(11), 'password1'), RangeError); // 33 bytes
  assert.equal(netWifiAddPayload('咖'.repeat(10), 'password1')[1], 30);
});

test('what the S3 would refuse is refused here, with the reason, before it is sent', () => {
  assert.throws(() => netWifiAddPayload('', 'password1'), /ssid/);
  assert.throws(() => netWifiAddPayload('x'.repeat(33), 'password1'), /ssid/);
  assert.throws(() => netWifiAddPayload('home', 'short'), /password/); // WPA needs 8 to 63; none at all is an open network
  assert.throws(() => netWifiAddPayload('home', 'x'.repeat(7)), /password/);
  assert.equal(netWifiAddPayload('home', 'x'.repeat(8))[6], 8);
  assert.throws(() => netWifiAddPayload('home', 'x'.repeat(64)), /password/);
  assert.equal(netWifiAddPayload('home', 'x'.repeat(63)).length, 2 + 4 + 1 + 63);
  assert.equal(netWifiAddPayload('x'.repeat(32), 'x'.repeat(8))[1], 32);
  assert.throws(() => netWifiAddPayload('home', null), TypeError);
  assert.throws(() => netWifiAddPayload(7, 'password1'), TypeError);
  assert.throws(() => netWifiRemovePayload(''), /ssid/);
  assert.throws(() => netWifiAddPayload('a\0b', 'password1'), /ssid.*NUL/);
  assert.throws(() => netWifiAddPayload('home', 'pass\0word'), /password.*NUL/);
  assert.throws(() => netWifiRemovePayload('a\0'), /ssid.*NUL/);
  for (const bad of ['', 'a b', 'a/b', 'a\r\nb', 'http://x.dev', 'x.dev:443', 'x'.repeat(64), 'é.dev']) {
    assert.throws(() => netRelaySetPayload(bad), RangeError, JSON.stringify(bad));
  }
  assert.equal(netRelaySetPayload('x'.repeat(63))[1], 63);
});

test('replies: OK, ERR and the list, and nothing that is not exactly one of them', () => {
  assert.deepEqual(parseNetReply(unhex('8001')), { kind: 'ok', answered: NET_OP.WIFI_ADD });
  assert.deepEqual(parseNetReply(unhex('810102')), { kind: 'err', answered: NET_OP.WIFI_ADD, reason: NET_ERR.FULL });
  assert.deepEqual(parseNetReply(unhex('820004')), null, 'a list that stops short of its host length');
  assert.deepEqual(parseNetReply(unhex('8200' + '00')), { kind: 'list', ssids: [], host: null });
  assert.deepEqual(parseNetReply(unhex('8202' + '04686f6d65' + '0463616665' + '09782e666c792e646576')), {
    kind: 'list',
    ssids: ['home', 'cafe'],
    host: 'x.fly.dev',
  });
  assert.deepEqual(parseNetReply(unhex('820104686f6d6500')), { kind: 'list', ssids: ['home'], host: null });
  assert.deepEqual(parseNetReply(unhex('8204' + '0161' + '0162' + '0163' + '0164' + '00')).ssids, ['a', 'b', 'c', 'd'], 'four is the most');
});

test('a reply that is the wrong length, or unknown, is null', () => {
  for (const h of ['', '80', '8001ff', '81', '8101', '810102ff', '82', '8205' + '00', '8201' + '05686f6d65' + '00', '8201' + '04686f6d65', '8200' + '0000', '8200' + '40', '7f01', '01', '8201' + '00' + '00']) {
    assert.equal(parseNetReply(unhex(h)), null, h);
  }
  // five networks cannot be, and an SSID of 33 bytes cannot be
  assert.equal(parseNetReply(unhex('8205' + '01610161016101610161' + '00')), null);
  assert.equal(parseNetReply(unhex('8201' + '21' + '61'.repeat(33) + '00')), null);
});
