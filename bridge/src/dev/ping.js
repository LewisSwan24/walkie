// Says HELLO, then prints n PONGs: round trip, the S3's uptime, and both ends' link counters.
import { connect, withTimeout } from './connect.js';

export default async function ping([n = '5'], opts) {
  const link = await connect(opts);
  for (let i = 0; i < Number(n); i++) {
    const p = await withTimeout(new Promise((r) => link.once('pong', r)), 3000, 'no PONG within 3 s');
    console.log(`pong: ${p.rttMs} ms round trip, S3 up ${(p.uptimeMs / 1000).toFixed(1)} s, S3 saw ${p.badChunks} bad chunks and ${p.seqGaps} gaps`);
  }
  console.log(`bridge saw ${link.badChunks} bad chunks and ${link.seqGaps} gaps`);
  link.close();
}
