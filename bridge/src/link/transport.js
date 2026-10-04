// Which carrier the Link gets. The cable wins: when the S3 is on USB that is the port. Without it the bridge goes by the relay, and
// while it is there it looks for the S3 on USB every few seconds and lets the relay go when it appears, so that the Link's next open
// is the cable. Only the relay is held back when another walkie run takes the room; the cable never is.

// The wait after a failure on the cable side (a port that is busy, a relay not set) is short, whatever backoff the Link has reached: the
// cable may be plugged in any moment. A relay that cannot be reached, or is held back, is left to the backoff.
export const CABLE_WAIT_MS = 1000;
const cableError = (message) => Object.assign(new Error(message), { retryInMs: CABLE_WAIT_MS });

// `findUsb()` answers the S3's USB path or null, `openUsb(path)` and `openRelay(host)` open a port, `relayHost()` is the relay in the
// config now (read on every open), `status(text)` is told what is worth a line on the console. Returns the `openPort` the Link wants.
export function chooseTransport({
  findUsb,
  openUsb,
  openRelay,
  relayHost,
  status = () => {},
  pollMs = 3000,
  replacedPenaltyMs = 5 * 60_000,
  now = Date.now,
}) {
  let relayHeldBackUntil = 0;

  const usbPath = async () => {
    try {
      return (await findUsb()) ?? null;
    } catch {
      return null; // a search that fails is an S3 that was not found
    }
  };

  function watch(port) {
    let searching = false;
    let gone = false;
    const timer = setInterval(async () => {
      if (searching) return;
      searching = true;
      try {
        if ((await usbPath()) && !gone) {
          status('the S3 is on USB: leaving the relay');
          port.close();
        }
      } finally {
        searching = false;
      }
    }, pollMs);
    timer.unref?.();
    port.on('close', () => {
      gone = true;
      clearInterval(timer);
      if (port.replaced) {
        relayHeldBackUntil = now() + replacedPenaltyMs;
        status(`another walkie run took the relay room; not going back to it for ${Math.round(replacedPenaltyMs / 60_000)} min`);
      }
    });
  }

  return async function openPort() {
    const path = await usbPath();
    if (path) {
      let port;
      try {
        port = await openUsb(path);
      } catch (err) {
        throw cableError(`cannot open the S3 on USB (${err.message})`); // it is there; the relay is no answer to a port that is busy
      }
      port.kind ??= 'usb';
      return port;
    }
    const host = relayHost();
    if (!host) throw cableError('no S3 on USB, and no relay set (walkie relay <host>)');
    if (now() < relayHeldBackUntil) throw new Error('another walkie run holds the relay room');
    const port = await openRelay(host);
    watch(port);
    return port;
  };
}
