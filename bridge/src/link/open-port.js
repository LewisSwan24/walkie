// The openPort that `walkie` gives the Link. The cable alone, unless there is a pairing key (it names the room) and a relay host in the
// config; then the transport chooser: the cable when the S3 is on it, the relay when not. `--port COMx` is always the cable alone.
import { findS3Port as defaultFindS3Port, openS3Port as defaultOpenS3Port } from './serial.js';
import { openRelayPort as defaultOpenRelayPort } from './relay-port.js';
import { roomId } from './room.js';
import { CABLE_WAIT_MS, chooseTransport } from './transport.js';

// Everything but the cable is injectable, for tests.
export function bridgeOpenPort({
  port = null,
  master = null,
  relayHost = () => null,
  log = () => {},
  pollMs,
  findS3Port = defaultFindS3Port,
  openS3Port = defaultOpenS3Port,
  openRelayPort = defaultOpenRelayPort,
}) {
  // The cable may be plugged in any moment, so what goes wrong here is retried soon whatever the Link's backoff has reached.
  const cable = async () => {
    try {
      const path = port ?? (await findS3Port());
      if (!path) throw new Error('no S3 on USB (303A:1001)');
      return await openS3Port(path);
    } catch (err) {
      err.retryInMs = CABLE_WAIT_MS;
      throw err;
    }
  };
  if (port) return cable;
  const room = master ? roomId(master) : null;
  let host = null;
  const chooser = chooseTransport({
    findUsb: findS3Port,
    openUsb: openS3Port,
    openRelay: (h) => openRelayPort({ host: h, room }),
    relayHost: () => host,
    status: log,
    pollMs,
  });
  return async () => {
    host = master ? relayHost() : null; // the config is read afresh: a relay set while the bridge runs is used from the next open
    return host ? chooser() : cable();
  };
}

// One line for the console at start: which way the bridge will go.
export function describeTransport({ master, host, port }) {
  if (port) return `USB only, on ${port} as asked`;
  if (master && host) return `USB when the S3 is on it, else the relay at ${host}`;
  if (host) return `USB only: the relay at ${host} needs a pairing key (node bridge/bin/walkie.js pair)`;
  if (master) return 'USB only (no relay set: node bridge/bin/walkie.js relay <host>)';
  return 'USB only';
}
