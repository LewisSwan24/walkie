// Turns `cmd <name> [value]` into a CMD op and argument, refusing what the S3 would misread.
import { CMD, cmdPayload } from '../link/messages.js';

const OPS = { vol: CMD.SET_VOLUME, gain: CMD.SET_MIC_GAIN, stop: CMD.STOP_AUDIO, 'boot-app0': CMD.BOOT_APP0, reboot: CMD.REBOOT };

export function parseCmdArgs([name, value]) {
  if (typeof name !== 'string' || !Object.hasOwn(OPS, name)) {
    throw new Error('cmd vol <0-255> | gain <1-64> | stop | boot-app0 | reboot');
  }
  const op = OPS[name];
  const arg = value === undefined ? undefined : Number(value);
  cmdPayload(op, arg); // throws RangeError on a bad argument
  return { op, arg };
}
