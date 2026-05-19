'use strict';

/**
 * envelope.js. OpenClaw Frontier signed envelope helpers.
 *
 * Envelope schema:
 *   { id, timestamp, from, to, type, subject, body, lineage, signature }
 *
 * Types: TASK | RESULT | FACT | OBSERVATION | DECISION | ALERT | BANTER | HEARTBEAT
 *
 * The public envelope type set is closed and matches the contract in
 * docs/bus-and-blackboard-protocol.md. Adding a type is a breaking change to
 * openclaw-frontier.envelope.v1.
 *
 * Signing: detached Ed25519 over canonical JSON of envelope minus signature.
 * Verifying: lookup public key in keys/<from>.pub (OpenSSH ssh-ed25519 format).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');


const VALID_TYPES = new Set([
  'TASK', 'RESULT', 'FACT', 'OBSERVATION', 'DECISION', 'ALERT', 'BANTER', 'HEARTBEAT',
]);
const MAX_SUBJECT_LENGTH = 200;
const MAX_BODY_BYTES = 32 * 1024;
const PUBLIC_SAFETY_PATTERNS = [
  { id: 'home-path', regex: /\/Users\/[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/ },
  { id: 'private-key', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'api-token', regex: /\b(?:sk-[A-Za-z0-9_-]{20,}|(?:ghp|github_pat)_[A-Za-z0-9_]{20,}|xox[abpors]-[A-Za-z0-9-]{20,})\b/ },
  { id: 'telegram-token', regex: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/ },
  { id: 'ipv4-address', regex: /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/ },
];

const HOME = process.env.USERPROFILE || process.env.HOME;
const DEFAULT_KEYS_DIR = path.join(process.cwd(), 'keys');

/**
 * Canonical JSON of envelope without `signature` field, keys sorted recursively.
 * Returns the exact bytes used for sign and verify.
 */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = stable(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function canonicalize(envelope) {
  const withoutTopLevelSignature = { ...envelope };
  delete withoutTopLevelSignature.signature;
  return JSON.stringify(stable(withoutTopLevelSignature));
}

function validateToken(value, field, { allowBroadcast = false } = {}) {
  const token = String(value || '').trim();
  if (allowBroadcast && token === '*') return token;
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(token)) {
    throw new Error(`${field} must be a simple agent id`);
  }
  return token.toLowerCase();
}

function validateSubject(value) {
  const subject = String(value || '').trim();
  if (!subject || subject.length > MAX_SUBJECT_LENGTH) {
    throw new Error(`subject must be 1-${MAX_SUBJECT_LENGTH} characters`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(subject)) {
    throw new Error('subject must be a simple route label');
  }
  return subject;
}

function validateLineage(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('lineage must be an array');
  return value.map((id) => {
    const s = String(id || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(s)) {
      throw new Error('lineage ids must be simple identifiers');
    }
    return s;
  });
}

function validatePublicSafeBody(body) {
  const text = JSON.stringify(body == null ? {} : body);
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    throw new Error(`body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  for (const pattern of PUBLIC_SAFETY_PATTERNS) {
    if (pattern.regex.test(text)) {
      throw new Error(`body failed production-safety scan: ${pattern.id}`);
    }
  }
}

/**
 * Build a new envelope.
 *
 * @param {object} opts
 * @param {string} opts.from
 * @param {string} opts.to
 * @param {string} opts.type
 * @param {string} opts.subject
 * @param {*}      opts.body
 * @param {string[]} [opts.lineage]
 */
function createEnvelope({ from, to, type, subject, body, lineage = [] }) {
  if (!VALID_TYPES.has(type)) {
    throw new Error(`Invalid envelope type: ${type}. Must be one of ${[...VALID_TYPES].join(', ')}`);
  }
  const safeBody = body == null ? {} : body;
  validatePublicSafeBody(safeBody);
  return {
    id: (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex')),
    timestamp: new Date().toISOString(),
    schema: 'openclaw-frontier.envelope.v1',
    from: validateToken(from, 'from'),
    to: validateToken(to, 'to', { allowBroadcast: true }),
    type,
    subject: validateSubject(subject),
    body: safeBody,
    lineage: validateLineage(lineage),
    signature: '',
  };
}

let _privCache = null;
function loadPrivateKey(privPath) {
  if (_privCache && _privCache.path === privPath) return _privCache.key;
  const pem = fs.readFileSync(privPath, 'utf8');
  const key = crypto.createPrivateKey({ key: pem, format: 'pem' });
  _privCache = { path: privPath, key };
  return key;
}

const _pubCache = new Map();
/**
 * Load an OpenSSH ssh-ed25519 public key as a Node KeyObject.
 * Format on disk: `ssh-ed25519 <base64-blob> <comment>`
 */
function loadPublicKey(from, keysDir = DEFAULT_KEYS_DIR) {
  const cacheKey = `${keysDir}|${from}`;
  if (_pubCache.has(cacheKey)) return _pubCache.get(cacheKey);

  const pubPath = path.join(keysDir, `${from}.pub`);
  if (!fs.existsSync(pubPath)) return null;

  const line = fs.readFileSync(pubPath, 'utf8').trim().split('\n')[0];
  const parts = line.split(/\s+/);
  if (parts.length < 2 || parts[0] !== 'ssh-ed25519') {
    throw new Error(`${pubPath} is not an ssh-ed25519 key`);
  }
  const blob = Buffer.from(parts[1], 'base64');
  // Wire format: [4-byte len][algo "ssh-ed25519"][4-byte len][32-byte raw key]
  const algoLen = blob.readUInt32BE(0);
  const keyOffset = 4 + algoLen;
  const keyLen = blob.readUInt32BE(keyOffset);
  const rawKey = blob.subarray(keyOffset + 4, keyOffset + 4 + keyLen);
  if (rawKey.length !== 32) {
    throw new Error(`Expected 32-byte Ed25519 key for ${from}, got ${rawKey.length} in ${pubPath}`);
  }
  const key = crypto.createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: rawKey.toString('base64url') },
    format: 'jwk',
  });
  _pubCache.set(cacheKey, key);
  return key;
}

/**
 * Sign an envelope in place. Returns the same envelope with `signature` populated.
 */
function sign(envelope, privPath) {
  const priv = loadPrivateKey(privPath);
  envelope.signature = '';
  const canonical = canonicalize(envelope);
  const sig = crypto.sign(null, Buffer.from(canonical, 'utf8'), priv);
  envelope.signature = sig.toString('base64');
  return envelope;
}

/**
 * Verify envelope signature. Returns { valid: boolean, reason: string }.
 * Caller decides whether to drop. Does not throw on missing key.
 */
function verify(envelope, opts = {}) {
  if (!envelope || typeof envelope !== 'object') {
    return { valid: false, reason: 'not-an-object' };
  }
  if (!envelope.signature) return { valid: false, reason: 'missing-signature' };
  if (!VALID_TYPES.has(envelope.type)) return { valid: false, reason: 'invalid-type' };
  if (envelope.schema && envelope.schema !== 'openclaw-frontier.envelope.v1') {
    return { valid: false, reason: 'invalid-schema' };
  }
  try {
    validateToken(envelope.from, 'from');
    validateToken(envelope.to, 'to', { allowBroadcast: true });
    validateSubject(envelope.subject);
    validateLineage(envelope.lineage);
    validatePublicSafeBody(envelope.body);
  } catch (err) {
    return { valid: false, reason: `invalid-envelope:${err.message}` };
  }

  const pub = loadPublicKey(envelope.from, opts.keysDir);
  if (!pub) return { valid: false, reason: `no-public-key-for-${envelope.from}` };

  try {
    const canonical = canonicalize(envelope);
    const sigBuf = Buffer.from(envelope.signature, 'base64');
    const ok = crypto.verify(null, Buffer.from(canonical, 'utf8'), pub, sigBuf);
    return ok ? { valid: true, reason: 'ok' } : { valid: false, reason: 'bad-signature' };
  } catch (err) {
    return { valid: false, reason: `verify-error:${err.message}` };
  }
}

module.exports = {
  VALID_TYPES: Array.from(VALID_TYPES),
  createEnvelope,
  canonicalize,
  stable,
  sign,
  verify,
  loadPublicKey,
  loadPrivateKey,
};
