'use strict';

/**
 * Regression test for audit finding H2: tampering with a NESTED `body.signature`
 * field MUST invalidate envelope verification.
 *
 * In the unpatched implementation, `stable()` recursively excluded every key
 * named `signature` from the canonical bytes. That meant a `body.signature`
 * field could be mutated post-sign without the verifier noticing.
 *
 * The fix in lib/envelope.js strips `signature` only at the top level (in
 * `canonicalize()`), so any nested `signature` key is part of the signed
 * bytes — and mutating it breaks verification.
 *
 * IMPORTANT: this test mutates `body.signature`, not deletes it. Deletion
 * alone can pass against the broken implementation because the recursive
 * strip and the delete are symmetric — both remove the key from canonical
 * bytes. Mutation forces the canonical bytes to diverge.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const envelope = require('../lib/envelope-loader');

function publicKeyOpenSsh(publicKey, comment) {
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.from(jwk.x, 'base64url');
  const algo = Buffer.from('ssh-ed25519');
  const blob = Buffer.concat([
    Buffer.alloc(4), algo,
    Buffer.alloc(4), raw,
  ]);
  blob.writeUInt32BE(algo.length, 0);
  blob.writeUInt32BE(raw.length, 4 + algo.length);
  return `ssh-ed25519 ${blob.toString('base64')} ${comment}`;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'h2-regression-'));
const keysDir = path.join(tmp, 'keys');
fs.mkdirSync(keysDir);

const agent = 'alpha';
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const privPath = path.join(keysDir, `${agent}.pem`);
fs.writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
fs.writeFileSync(
  path.join(keysDir, `${agent}.pub`),
  publicKeyOpenSsh(publicKey, agent) + '\n',
);

// Build an envelope whose body contains a key literally named `signature`.
const env = envelope.createEnvelope({
  from: agent,
  to: agent,
  type: 'OBSERVATION',
  subject: 'h2-nested-signature',
  body: { value: 1, signature: 'attached-evidence-original' },
});
envelope.sign(env, privPath);

// 1. The original envelope MUST verify.
const v1 = envelope.verify(env, { keysDir });
assert.strictEqual(v1.valid, true,
  `expected original envelope to verify, got reason: ${v1.reason}`);

// 2. Mutate the nested body.signature (do NOT delete — see file header).
const tampered = JSON.parse(JSON.stringify(env));
tampered.body.signature = 'attached-evidence-forged';

const v2 = envelope.verify(tampered, { keysDir });
assert.strictEqual(v2.valid, false,
  'H2 fix regressed: nested body.signature was tampered without breaking verify');
assert.strictEqual(v2.reason, 'bad-signature',
  `expected reason 'bad-signature', got '${v2.reason}'`);

// 3. The canonical form MUST preserve nested signature keys while stripping
//    the top-level signature.
const sample = {
  type: 'OBSERVATION',
  body: { signature: 'inner-evidence', x: 1 },
  signature: 'outer-envelope-sig',
};
const canonical = envelope.canonicalize(sample);
assert.ok(!canonical.includes('"signature":"outer-envelope-sig"'),
  `canonical form must strip top-level signature; got: ${canonical}`);
assert.ok(canonical.includes('"signature":"inner-evidence"'),
  `canonical form must preserve nested body.signature; got: ${canonical}`);

fs.rmSync(tmp, { recursive: true, force: true });

console.log('PASS nested-signature-tamper.test.js');
