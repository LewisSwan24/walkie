// `walkie wifi add|list|remove` and the relay host sent on to the S3: runNet with the console around it, and an exit code (0 done, 1
// it did not happen, 2 what was typed is wrong). A password is read at the terminal, asked twice, and never printed or kept.
import { runNet } from './net.js';
import {
  NET_ERR,
  NET_OP,
  netRelayClearPayload,
  netRelaySetPayload,
  netWifiAddPayload,
  netWifiListPayload,
  netWifiRemovePayload,
} from './link/messages.js';

const NEED_KEY = 'Wi-Fi and relay settings go to walkie sealed, so a pairing key comes first (node bridge/bin/walkie.js pair)';
const WHY = {
  [NET_ERR.BAD]: 'walkie refused the request as malformed',
  [NET_ERR.FULL]: 'walkie already holds 4 Wi-Fi networks: remove one first (node bridge/bin/walkie.js wifi remove <ssid>)',
  [NET_ERR.UNKNOWN]: 'walkie holds no such network (node bridge/bin/walkie.js wifi list)',
  [NET_ERR.STORE]: 'walkie could not save it, so nothing changed',
};
const NO_ANSWER = 'walkie did not answer. See what it holds with: node bridge/bin/walkie.js wifi list';

// Sends `request` and tells what came of it: { reply } to go on with, or { code } when it is over.
async function send({ request, master, openPort, run, err, ...options }) {
  let result;
  try {
    result = await run({ openPort, master, request, ...options });
  } catch (e) {
    err(e.message);
    return { code: 1 };
  }
  if (result.reply === null) {
    err(NO_ANSWER);
    return { code: 1 };
  }
  if (result.reply.kind === 'err') {
    err(WHY[result.reply.reason] ?? `walkie refused (reason ${result.reply.reason})`);
    return { code: 1 };
  }
  return { reply: result.reply };
}

export async function wifiCommand({
  action,
  ssid = null,
  master,
  openPort,
  readSecret,
  run = runNet,
  say = console.log,
  err = console.error,
  ...options
}) {
  if (!master) {
    err(NEED_KEY);
    return 1;
  }
  let request;
  let open = false;
  if (action === 'add') {
    try {
      netWifiAddPayload(ssid, ''); // the SSID alone is checked first, so that nobody types a password for one that cannot be
    } catch (e) {
      err(`walkie: ${e.message}`);
      return 2;
    }
    let pass;
    try {
      pass = await readSecret(`Wi-Fi password for "${ssid}" (typing is hidden; Enter with nothing for an open network): `);
      if (pass !== '' && pass !== (await readSecret('Again: '))) {
        err('walkie: the two passwords differ: nothing was sent');
        return 1;
      }
    } catch (e) {
      err(e.message);
      return 1;
    }
    try {
      request = netWifiAddPayload(ssid, pass);
    } catch (e) {
      err(`walkie: ${e.message}`);
      return 2;
    }
    open = pass === '';
  } else if (action === 'remove') {
    try {
      request = netWifiRemovePayload(ssid);
    } catch (e) {
      err(`walkie: ${e.message}`);
      return 2;
    }
  } else {
    request = netWifiListPayload();
  }
  const { reply, code } = await send({ request, master, openPort, run, err, ...options });
  if (reply === undefined) return code;
  if (action === 'add') say(`walkie now holds "${ssid}"${open ? ' (an open network)' : ''}`);
  else if (action === 'remove') say(`walkie forgot "${ssid}"`);
  else {
    if (reply.ssids.length === 0) say('walkie holds no Wi-Fi network (node bridge/bin/walkie.js wifi add <ssid>)');
    else {
      say('Wi-Fi networks on walkie, tried in this order:');
      reply.ssids.forEach((name, i) => say(`  ${i + 1}. ${name}`));
    }
    say(`relay on walkie: ${reply.host ?? 'none'}`);
  }
  return 0;
}

// After `walkie relay <host>` or `--forget` has done its part on this PC: the same on the S3.
export async function relayPushCommand({ host, forget, master, openPort, run = runNet, say = console.log, err = console.error, ...options }) {
  if (!master) {
    err(NEED_KEY);
    return 1;
  }
  let request;
  try {
    request = forget ? netRelayClearPayload() : netRelaySetPayload(host);
  } catch (e) {
    err(`walkie: ${e.message}`);
    return 2;
  }
  const { code } = await send({ request, master, openPort, run, err, ...options });
  if (code !== undefined) return code;
  say(forget ? 'walkie no longer has a relay' : `walkie now uses the relay ${host}`);
  return 0;
}
