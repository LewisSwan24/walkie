#!/usr/bin/env node
// Starts the relay from the environment: PORT (default 8080), HOST (default 0.0.0.0), TRUST_PROXY=1 behind Fly's proxy, MAX_CONNECTIONS,
// MAX_PER_IP. It logs only that rooms were joined, and only the first characters of a room id.
import { startRelay } from '../src/server.js';

const env = process.env;
const number = (name, fallback) => {
  const n = Number(env[name] ?? fallback);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number`);
  return n;
};

const relay = await startRelay({
  port: number('PORT', 8080),
  host: env.HOST ?? '0.0.0.0',
  trustProxy: env.TRUST_PROXY === '1',
  maxConnections: number('MAX_CONNECTIONS', 64),
  maxPerIp: number('MAX_PER_IP', 8),
  log: (line) => console.log(line),
});
console.log(`walkie relay listening on port ${relay.port}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await relay.close();
    process.exit(0);
  });
}
