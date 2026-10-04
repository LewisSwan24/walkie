// The roots the S3 trusts for the relay: the committed header holds exactly the two pinned ones, and the picker refuses a bundle that
// does not give them as they should be.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELAY_ROOT_FINGERPRINTS, RELAY_ROOT_LABELS, parseRootsHeader, pickRoots, rootsHeader } from '../lib/roots.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const header = readFileSync(path.join(root, 'firmware', 'src', 'relay_roots.h'), 'utf8');
const pems = parseRootsHeader(header);
const bundleOf = (entries) => entries.map(([label, pem]) => `\n# Issuer: x\n# Label: "${label}"\n# Serial: 1\n${pem}`).join('');

test('relay_roots.h holds ISRG Root X1 and X2, and nothing else', () => {
  assert.equal(pems.length, 2);
  const certs = pems.map((p) => new X509Certificate(p));
  assert.deepEqual(
    certs.map((c) => c.fingerprint256),
    RELAY_ROOT_LABELS.map((l) => RELAY_ROOT_FINGERPRINTS[l]),
  );
  for (const c of certs) assert.ok(c.ca && c.subject === c.issuer, 'self-signed CAs');
  assert.match(header, /static const char RELAY_ROOTS_PEM\[\] =/);
  assert.match(header, /\\n";\r?\n$/, 'one C string, ended'); // a checkout with core.autocrlf has CRLF
});

test('the header is what the generator writes from those two', () => {
  const roots = pickRoots(bundleOf(RELAY_ROOT_LABELS.map((l, i) => [l, pems[i]])));
  assert.equal(rootsHeader(roots), header.replace(/\r\n/g, '\n'));
});

test('the picker takes them in the order asked, from a bundle with CRLF line ends', () => {
  const bundle = bundleOf([['Other', pems[0]], ['ISRG Root X2', pems[1]], ['ISRG Root X1', pems[0]]]).replace(/\n/g, '\r\n');
  assert.deepEqual(
    pickRoots(bundle).map((r) => r.label),
    ['ISRG Root X1', 'ISRG Root X2'],
  );
});

test('a missing root, or one whose fingerprint is not the pinned one, is refused', () => {
  assert.throws(() => pickRoots(bundleOf([['ISRG Root X1', pems[0]]])), /no "ISRG Root X2"/);
  assert.throws(() => pickRoots(bundleOf([['ISRG Root X1', pems[1]], ['ISRG Root X2', pems[1]]])), /ISRG Root X1" has fingerprint/);
  assert.throws(() => pickRoots('# Label: "ISRG Root X1"\nno pem here\n'), /no certificate after/);
});
