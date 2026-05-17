'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const envelope = require('../lib/envelope');

function publicKeyOpenSsh(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.from(jwk.x, 'base64url');
  const algo = Buffer.from('ssh-ed25519');
  const blob = Buffer.concat([
    Buffer.alloc(4), algo,
    Buffer.alloc(4), raw,
  ]);
  blob.writeUInt32BE(algo.length, 0);
  blob.writeUInt32BE(raw.length, 4 + algo.length);
  return `ssh-ed25519 ${blob.toString('base64')} demo-neo`;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-frontier-bus-'));
const keysDir = path.join(tmp, 'keys');
fs.mkdirSync(keysDir);
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const privPath = path.join(keysDir, 'neo.pem');
fs.writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
fs.writeFileSync(path.join(keysDir, 'neo.pub'), publicKeyOpenSsh(publicKey));

const env = envelope.createEnvelope({
  from: 'neo',
  to: 'sentinel',
  type: 'TASK',
  subject: 'demo-release-gate',
  body: { summary: 'Run production release gate.' },
});

envelope.sign(env, privPath);
assert(env.signature, 'signature should be populated');
assert.deepStrictEqual(envelope.verify(env, { keysDir }), { valid: true, reason: 'ok' });

const tampered = { ...env, body: { summary: 'Tampered.' } };
assert.strictEqual(envelope.verify(tampered, { keysDir }).valid, false, 'tampered body must fail verification');

assert.throws(() => envelope.createEnvelope({ from: 'neo', to: 'sentinel', type: 'NOPE', subject: 'bad', body: {} }), /Invalid envelope type/);

console.log(JSON.stringify({ ok: true, signed: true, verified: true, tamperRejected: true, types: envelope.VALID_TYPES }, null, 2));
