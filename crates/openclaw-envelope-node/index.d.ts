/* tslint:disable */
/* eslint-disable */

/**
 * Canonical JSON of `value` with the top-level `signature` field stripped.
 * Bytes are UTF-8 and identical to `JSON.stringify` over the same value
 * after recursive key-sort (Node `envelope.js` parity).
 */
export function canonicalize(value: unknown): Buffer;

/**
 * Stable JSON of `value` with no field stripping. Equivalent to
 * `JSON.stringify(stable(value))` from `envelope.js` but returned as a
 * UTF-8 byte buffer.
 */
export function stable(value: unknown): Buffer;

/**
 * Sign an envelope. Reads the PKCS#8 PEM private key at `keyPath`, computes
 * the canonical bytes (with top-level signature cleared), Ed25519-signs them,
 * and returns the envelope with `signature` set to the base64-encoded
 * detached signature.
 */
export function sign<E extends Record<string, unknown>>(envelope: E, keyPath: string): E & { signature: string };

/**
 * Verify an envelope's signature against a raw 32-byte Ed25519 public key
 * buffer. Returns true on a valid signature, false on any failure (missing
 * signature, malformed base64, wrong key, tampered bytes).
 *
 * The caller is responsible for extracting the 32 raw bytes from the
 * OpenSSH `<from>.pub` blob.
 */
export function verify(envelope: Record<string, unknown>, publicKey: Buffer): boolean;
