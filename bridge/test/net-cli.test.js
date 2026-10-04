// walkie wifi add|list|remove and the relay host sent on to the S3: the console around runNet, and an exit code. `run` stands in for
// runNet, so what is checked here is what is asked, what is said and what is never said (a password).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relayPushCommand, wifiCommand } from '../src/net-cli.js';
import {
  NET_ERR,
  NET_OP,
  netRelayClearPayload,
  netRelaySetPayload,
  netWifiAddPayload,
  netWifiListPayload,
  netWifiRemovePayload,
} from '../src/link/messages.js';

const KEY = Buffer.alloc(32, 7);

function fixture({ replies = [], typed = [], master = KEY } = {}) {
  const said = [];
  const errs = [];
  const asked = [];
  const calls = [];
  const queue = [...replies];
  const keys = [...typed];
  const f = {
    said,
    errs,
    asked,
    calls,
    all: () => [...said, ...errs, ...asked].join('\n'),
    base: {
      master,
      openPort: async () => null,
      say: (s) => said.push(s),
      err: (s) => errs.push(s),
      readSecret: async (q) => {
        asked.push(q);
        const next = keys.shift();
        if (next instanceof Error) throw next;
        return next ?? '';
      },
      run: async (options) => {
        calls.push(options);
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return { reply: next ?? null };
      },
    },
  };
  return f;
}
const ok = (op) => ({ kind: 'ok', answered: op });
const refused = (op, reason) => ({ kind: 'err', answered: op, reason });

test('wifi add asks for the password twice, with typing hidden, and sends the request sealed through runNet', async () => {
  const f = fixture({ typed: ['secret123', 'secret123'], replies: [ok(NET_OP.WIFI_ADD)] });
  const code = await wifiCommand({ ...f.base, action: 'add', ssid: 'home' });
  assert.equal(code, 0);
  assert.equal(f.asked.length, 2);
  assert.match(f.asked[0], /Wi-Fi password for "home"/);
  assert.match(f.asked[0], /hidden/);
  assert.deepEqual(f.calls[0].request, netWifiAddPayload('home', 'secret123'));
  assert.equal(f.calls[0].master, KEY);
  assert.deepEqual(f.said, ['walkie now holds "home"']);
});

test('an empty password is an open network, and is asked for once', async () => {
  const f = fixture({ typed: [''], replies: [ok(NET_OP.WIFI_ADD)] });
  assert.equal(await wifiCommand({ ...f.base, action: 'add', ssid: 'cafe' }), 0);
  assert.equal(f.asked.length, 1);
  assert.deepEqual(f.calls[0].request, netWifiAddPayload('cafe', ''));
  assert.deepEqual(f.said, ['walkie now holds "cafe" (an open network)']);
});

test('two passwords that differ send nothing, and say so without saying either', async () => {
  const f = fixture({ typed: ['secret123', 'secret124'] });
  assert.equal(await wifiCommand({ ...f.base, action: 'add', ssid: 'home' }), 1);
  assert.equal(f.calls.length, 0);
  assert.match(f.errs[0], /differ.*nothing was sent/);
  assert.ok(!f.all().includes('secret12'));
});

test('an SSID that cannot be is exit 2 before a password is asked for', async () => {
  const f = fixture();
  assert.equal(await wifiCommand({ ...f.base, action: 'add', ssid: 'x'.repeat(33) }), 2);
  assert.match(f.errs[0], /^walkie: the ssid must be 1 to 32 bytes/);
  assert.equal(f.asked.length, 0);
  assert.equal(f.calls.length, 0);
});

test('a password that cannot be is exit 2, nothing is sent, and the password is not repeated', async () => {
  const f = fixture({ typed: ['short', 'short'] });
  assert.equal(await wifiCommand({ ...f.base, action: 'add', ssid: 'home' }), 2);
  assert.match(f.errs[0], /^walkie: the password must be 8 to 63 bytes/);
  assert.equal(f.calls.length, 0);
  assert.ok(!f.errs.join('\n').includes('short'));
});

test('without a pairing key nothing is asked and nothing is sent: NET goes sealed only', async () => {
  for (const action of ['add', 'list', 'remove']) {
    const f = fixture({ master: null });
    assert.equal(await wifiCommand({ ...f.base, action, ssid: 'home' }), 1);
    assert.match(f.errs[0], /pairing key comes first/);
    assert.equal(f.asked.length, 0);
    assert.equal(f.calls.length, 0);
  }
});

test('a password prompt that is cancelled, or is not at a terminal, is exit 1 with its message and nothing sent', async () => {
  const f = fixture({ typed: [new Error('cancelled')] });
  assert.equal(await wifiCommand({ ...f.base, action: 'add', ssid: 'home' }), 1);
  assert.deepEqual(f.errs, ['cancelled']);
  assert.equal(f.calls.length, 0);
  const g = fixture({ typed: [new Error('a password is typed at a terminal, and this is not one: run this command in your own terminal')] });
  assert.equal(await wifiCommand({ ...g.base, action: 'add', ssid: 'home' }), 1);
  assert.match(g.errs[0], /not one/);
});

test('the reasons the S3 gives are said in words, and the exit code is 1', async () => {
  const cases = [
    [NET_ERR.FULL, /already holds 4 Wi-Fi networks.*wifi remove/],
    [NET_ERR.STORE, /could not save it, so nothing changed/],
    [NET_ERR.BAD, /malformed/],
    [99, /reason 99/],
  ];
  for (const [reason, pattern] of cases) {
    const f = fixture({ typed: ['secret123', 'secret123'], replies: [refused(NET_OP.WIFI_ADD, reason)] });
    assert.equal(await wifiCommand({ ...f.base, action: 'add', ssid: 'home' }), 1);
    assert.match(f.errs[0], pattern);
    assert.ok(!f.all().includes('secret123'), 'the password is not echoed in any message');
  }
});

test('remove sends the SSID, and says when walkie did not hold it', async () => {
  const f = fixture({ replies: [ok(NET_OP.WIFI_REMOVE), refused(NET_OP.WIFI_REMOVE, NET_ERR.UNKNOWN)] });
  assert.equal(await wifiCommand({ ...f.base, action: 'remove', ssid: 'home' }), 0);
  assert.deepEqual(f.calls[0].request, netWifiRemovePayload('home'));
  assert.deepEqual(f.said, ['walkie forgot "home"']);
  assert.equal(await wifiCommand({ ...f.base, action: 'remove', ssid: 'home' }), 1);
  assert.match(f.errs[0], /holds no such network.*wifi list/);
});

test('list prints the networks in order and the relay, or says there are none', async () => {
  const f = fixture({
    replies: [
      { kind: 'list', ssids: ['home', 'cafe'], host: 'walkie-relay.fly.dev' },
      { kind: 'list', ssids: [], host: null },
    ],
  });
  assert.equal(await wifiCommand({ ...f.base, action: 'list' }), 0);
  assert.deepEqual(f.calls[0].request, netWifiListPayload());
  assert.deepEqual(f.said, ['Wi-Fi networks on walkie, tried in this order:', '  1. home', '  2. cafe', 'relay on walkie: walkie-relay.fly.dev']);
  f.said.length = 0;
  assert.equal(await wifiCommand({ ...f.base, action: 'list' }), 0);
  assert.deepEqual(f.said, ['walkie holds no Wi-Fi network (node bridge/bin/walkie.js wifi add <ssid>)', 'relay on walkie: none']);
});

test('no answer is exit 1 with how to find out what happened, and an error from runNet is its own message', async () => {
  const f = fixture({ typed: ['secret123', 'secret123'], replies: [null, new Error('no walkie answered within 10 s: is it plugged in')] });
  assert.equal(await wifiCommand({ ...f.base, action: 'add', ssid: 'home' }), 1);
  assert.match(f.errs[0], /did not answer.*wifi list/);
  assert.equal(await wifiCommand({ ...f.base, action: 'list' }), 1);
  assert.equal(f.errs[1], 'no walkie answered within 10 s: is it plugged in');
});

test('the options for the link are passed on to runNet', async () => {
  const f = fixture({ replies: [{ kind: 'list', ssids: [], host: null }] });
  await wifiCommand({ ...f.base, action: 'list', helloMs: 123, answerMs: 456 });
  assert.equal(f.calls[0].helloMs, 123);
  assert.equal(f.calls[0].answerMs, 456);
  assert.equal(typeof f.calls[0].openPort, 'function');
});

test('the relay host goes on to the S3, or off it', async () => {
  const f = fixture({ replies: [ok(NET_OP.RELAY_SET), ok(NET_OP.RELAY_CLEAR)] });
  assert.equal(await relayPushCommand({ ...f.base, host: 'walkie-relay.fly.dev', forget: false }), 0);
  assert.deepEqual(f.calls[0].request, netRelaySetPayload('walkie-relay.fly.dev'));
  assert.deepEqual(f.said, ['walkie now uses the relay walkie-relay.fly.dev']);
  assert.equal(await relayPushCommand({ ...f.base, host: null, forget: true }), 0);
  assert.deepEqual(f.calls[1].request, netRelayClearPayload());
  assert.equal(f.said[1], 'walkie no longer has a relay');
});

test('a relay that did not go on is exit 1 and says why', async () => {
  const f = fixture({ replies: [refused(NET_OP.RELAY_SET, NET_ERR.STORE), null] });
  assert.equal(await relayPushCommand({ ...f.base, host: 'a.fly.dev', forget: false }), 1);
  assert.match(f.errs[0], /could not save it/);
  assert.equal(await relayPushCommand({ ...f.base, host: 'a.fly.dev', forget: false }), 1);
  assert.match(f.errs[1], /did not answer.*wifi list/);
});

test('a relay host that is not one is exit 2 and sends nothing', async () => {
  const f = fixture();
  assert.equal(await relayPushCommand({ ...f.base, host: 'a b', forget: false }), 2);
  assert.equal(f.calls.length, 0);
});

test('a relay push without a pairing key says so and sends nothing', async () => {
  const f = fixture({ master: null });
  assert.equal(await relayPushCommand({ ...f.base, host: 'a.fly.dev', forget: false }), 1);
  assert.match(f.errs[0], /pairing key comes first/);
  assert.equal(f.calls.length, 0);
});


test('remove with an SSID that cannot be is exit 2 and sends nothing', async () => {
  const f = fixture();
  assert.equal(await wifiCommand({ ...f.base, action: 'remove', ssid: 'x'.repeat(33) }), 2);
  assert.match(f.errs[0], /^walkie: the ssid must be 1 to 32 bytes/);
  assert.equal(f.calls.length, 0);
});
