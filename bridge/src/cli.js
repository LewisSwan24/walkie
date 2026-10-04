// The command line of bin/walkie.js, apart from the process: `walkie [options]` runs the bridge, `walkie pair [--forget] [--port COMx]`
// pairs (or unpairs) the S3 over the cable, `walkie relay [<host>|--forget] [--pc-only]` sets, shows or forgets the relay host (on this PC,
// and on the S3 unless --pc-only), and `walkie wifi add <ssid> | list | remove <ssid>` sets the S3's Wi-Fi networks.
import { UsageError, parseArgs } from './dev/args.js';

export function parseWalkieCommand(argv) {
  const { name, args, opts } = parseArgs(argv);
  if (name === 'pair') {
    const extra = args.find((word) => word !== '--forget');
    if (extra !== undefined) throw new UsageError(`${extra} is not something walkie pair takes`);
    for (const option of Object.keys(opts)) if (option !== 'port') throw new UsageError(`--${option} is not something walkie pair takes`);
    return { command: 'pair', forget: args.includes('--forget'), opts };
  }
  if (name === 'relay') {
    const stray = args.find((word) => word.startsWith('--') && word !== '--forget' && word !== '--pc-only');
    if (stray !== undefined) throw new UsageError(`${stray} is not something walkie relay takes`);
    for (const option of Object.keys(opts)) if (option !== 'port') throw new UsageError(`--${option} is not something walkie relay takes`);
    const forget = args.includes('--forget');
    const pcOnly = args.includes('--pc-only');
    const hosts = args.filter((word) => word !== '--forget' && word !== '--pc-only');
    if (hosts.length > 1) throw new UsageError(`${hosts[1]} is not something walkie relay takes`);
    if (forget && hosts.length > 0) throw new UsageError('walkie relay --forget takes no host');
    if (pcOnly && !forget && hosts.length === 0) throw new UsageError('walkie relay --pc-only goes with a host or --forget');
    return { command: 'relay', host: hosts[0] ?? null, forget, pcOnly, opts };
  }
  if (name === 'wifi') {
    for (const option of Object.keys(opts)) if (option !== 'port') throw new UsageError(`--${option} is not something walkie wifi takes`);
    const [action, ...rest] = args;
    if (action !== 'add' && action !== 'list' && action !== 'remove') throw new UsageError('walkie wifi is add <ssid>, list or remove <ssid>');
    const wants = action === 'list' ? 0 : 1;
    if (rest.length < wants) throw new UsageError(`walkie wifi ${action} needs the network's name`);
    if (rest.length > wants) throw new UsageError(`${rest[wants]} is not something walkie wifi ${action} takes`);
    return { command: 'wifi', action, ssid: rest[0] ?? null, opts };
  }
  const words = [name, ...args].filter((word) => word !== undefined);
  const stray = words.find((word) => word !== '--clean-env');
  if (stray !== undefined) throw new UsageError(`${stray} is not something walkie takes`);
  return { command: 'run', cleanEnv: words.includes('--clean-env'), opts };
}
