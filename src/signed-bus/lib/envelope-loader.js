'use strict';

/**
 * envelope-loader.js. Selects between the native N-API binding and the
 * pure-JS implementation at require-time.
 *
 * Resolution order:
 *   1. Try `require('../../../crates/openclaw-envelope-node')`.
 *      That entrypoint already handles per-triple lookup of the prebuilt
 *      `.node` file; if no prebuilt is present (or this host is an
 *      unsupported triple) the require throws synchronously.
 *   2. On any failure, fall back to the pure-JS module at `./envelope.js`.
 *
 * Either path exposes the same surface as `envelope.js`:
 *   - canonicalize(envelope)       -> string  (top-level signature stripped)
 *   - stable(value)                -> JS object/primitive (sorted, no stripping)
 *   - sign(envelope, privPath)     -> envelope (mutated in place)
 *   - verify(envelope, opts)       -> { valid, reason }
 *   - createEnvelope({...})        -> envelope
 *   - loadPublicKey(from, keysDir) -> KeyObject | null
 *   - loadPrivateKey(privPath)     -> KeyObject
 *   - VALID_TYPES                  -> string[]
 *   - _native                      -> boolean (true if native arm is active)
 *
 * The native arm only accelerates the byte-producing primitives. JS-side
 * input validation, OpenSSH public-key parsing, and the `{ valid, reason }`
 * verify surface are kept here so consumers do not see any behavioural
 * difference between the two paths. Byte-for-byte parity is guarded by
 * `src/signed-bus/test/envelope-parity.test.js`.
 */

const js = require('./envelope.js');

let native = null;
try {
  // eslint-disable-next-line global-require
  native = require('../../../crates/openclaw-envelope-node');
} catch (err) {
  native = null;
}

function isNativeUsable(mod) {
  return Boolean(
    mod
    && typeof mod.canonicalize === 'function'
    && typeof mod.stable === 'function'
    && typeof mod.sign === 'function'
    && typeof mod.verify === 'function',
  );
}

if (!isNativeUsable(native)) {
  module.exports = Object.assign({}, js, { _native: false });
  return;
}

// --- native-backed surface -------------------------------------------------

function canonicalize(value) {
  const buf = native.canonicalize(value);
  // Native returns a Node Buffer of UTF-8 bytes; the JS surface returns a
  // string. Decode once at the boundary.
  return Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
}

function stable(value) {
  // The JS surface returns a sorted JS object/primitive (consumed internally
  // by canonicalize before stringification). Native `stable` returns bytes,
  // which would change the surface — so we keep the JS shape here. The
  // parity test compares byte forms via JSON.stringify on the JS side and
  // toString('utf8') on the native side.
  return js.stable(value);
}

function sign(envelope, privPath) {
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('envelope must be an object');
  }
  const signed = native.sign(envelope, privPath);
  // Native returns a fresh object; mirror the JS in-place mutation by
  // copying the signature back into the caller's envelope reference.
  envelope.signature = signed && signed.signature ? signed.signature : '';
  return envelope;
}

function verify(envelope, opts = {}) {
  // Run the JS-side input validation first so we keep the `{ valid, reason }`
  // surface and the same reason taxonomy. This also catches malformed envelopes
  // before native sees them.
  if (!envelope || typeof envelope !== 'object') {
    return { valid: false, reason: 'not-an-object' };
  }
  if (!envelope.signature) return { valid: false, reason: 'missing-signature' };

  // Reuse the JS verifier for everything up to the actual Ed25519 check.
  // It loads the OpenSSH `<from>.pub` key, validates schema/type/subject/etc.
  // and returns an early `{ valid: false, reason }` on any failure.
  const jsResult = js.verify(envelope, opts);
  if (!jsResult.valid) return jsResult;

  // JS path already verified the signature successfully. Cross-check via
  // native to guard against a parity regression: extract the raw 32-byte
  // Ed25519 key and run native verify over the same canonical bytes.
  const pub = js.loadPublicKey(envelope.from, opts.keysDir);
  if (!pub) {
    return { valid: false, reason: `no-public-key-for-${envelope.from}` };
  }
  let raw;
  try {
    const jwk = pub.export({ format: 'jwk' });
    raw = Buffer.from(jwk.x, 'base64url');
  } catch (err) {
    // If we cannot extract the raw key, defer to the JS result.
    return jsResult;
  }
  if (raw.length !== 32) return jsResult;

  let nativeOk = false;
  try {
    nativeOk = native.verify(envelope, raw);
  } catch (err) {
    return { valid: false, reason: `verify-error:${err.message}` };
  }
  return nativeOk
    ? { valid: true, reason: 'ok' }
    : { valid: false, reason: 'bad-signature' };
}

module.exports = {
  VALID_TYPES: js.VALID_TYPES,
  createEnvelope: js.createEnvelope,
  canonicalize,
  stable,
  sign,
  verify,
  loadPublicKey: js.loadPublicKey,
  loadPrivateKey: js.loadPrivateKey,
  _native: true,
};
