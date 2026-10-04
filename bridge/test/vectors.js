// Loads protocol/vectors.json, the cases the firmware's host tests also run.
import { readFileSync } from 'node:fs';

export const vectors = JSON.parse(readFileSync(new URL('../../protocol/vectors.json', import.meta.url), 'utf8'));
export const hex = (s) => Buffer.from(s, 'hex');
