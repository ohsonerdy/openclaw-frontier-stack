//! N-API bindings for `openclaw-envelope`.
//!
//! This crate exposes four functions to Node.js via napi-rs:
//!
//! - `canonicalize(value) -> Buffer`  — canonical JSON of `value` with the
//!   top-level `signature` stripped. Mirrors `envelope.js#canonicalize`.
//! - `stable(value) -> Buffer`        — canonical JSON of `value` with NO
//!   stripping, recursively key-sorted. Mirrors `envelope.js#stable` followed
//!   by `JSON.stringify` (the JS `stable()` returns a sorted JS object; we
//!   skip that intermediate step and return the bytes directly).
//! - `sign(envelope, keyPath) -> Object` — load the PKCS#8 PEM private key at
//!   `keyPath`, sign the canonical bytes, return the envelope with the
//!   base64-encoded signature populated.
//! - `verify(envelope, publicKey) -> bool` — verify the envelope's signature
//!   against a raw 32-byte Ed25519 public key. The JS loader is responsible
//!   for reading the OpenSSH `<from>.pub` file and extracting the raw key.
//!
//! The byte-for-byte parity with the JS implementation is guarded by
//! `src/signed-bus/test/envelope-parity.test.js`, which feeds the same
//! canonical-corpus fixture through both paths.

#![deny(clippy::all)]

use napi::bindgen_prelude::Buffer;
use napi::{Error, Result, Status};
use napi_derive::napi;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use ed25519_dalek::pkcs8::DecodePrivateKey;
use ed25519_dalek::{
    Signature, Signer as DalekSigner, SigningKey, Verifier as DalekVerifier, VerifyingKey,
};
use serde_json::Value;
use std::fs;
use std::path::Path;

use openclaw_envelope::canonicalize as core_canonicalize;

// Re-export the dalek crate from openclaw-envelope's dep graph by pulling it
// in transitively. The path dep on `openclaw-envelope` brings ed25519-dalek
// into our lockfile already; we list it as a direct dep below to make the
// type names available here.

// --- helpers ----------------------------------------------------------------

fn invalid(msg: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, msg.into())
}

fn io_err(msg: impl Into<String>) -> Error {
    Error::new(Status::GenericFailure, msg.into())
}

/// Recursively key-sort a JSON value. Arrays preserve order; objects emit
/// keys in sorted order. Does NOT strip a top-level `signature` (that is
/// `canonicalize`'s job).
fn stable_string(value: &Value) -> String {
    let mut out = String::new();
    emit_stable(value, &mut out);
    out
}

fn emit_stable(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&n.to_string()),
        Value::String(s) => emit_string(s, out),
        Value::Array(arr) => {
            out.push('[');
            let mut first = true;
            for v in arr {
                if !first {
                    out.push(',');
                }
                first = false;
                emit_stable(v, out);
            }
            out.push(']');
        }
        Value::Object(obj) => {
            let mut keys: Vec<&String> = obj.keys().collect();
            keys.sort();
            out.push('{');
            let mut first = true;
            for k in keys {
                if !first {
                    out.push(',');
                }
                first = false;
                emit_string(k, out);
                out.push(':');
                emit_stable(&obj[k], out);
            }
            out.push('}');
        }
    }
}

/// Emit a JSON-escaped string matching Node's `JSON.stringify` byte output.
/// Duplicated from `openclaw-envelope::emit_string` because that function is
/// private; the canonical corpus tests guard parity.
fn emit_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{0009}' => out.push_str("\\t"),
            '\u{000A}' => out.push_str("\\n"),
            '\u{000C}' => out.push_str("\\f"),
            '\u{000D}' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

// --- napi exports -----------------------------------------------------------

/// Canonical JSON of `value` with the top-level `signature` field stripped.
/// Returns a `Buffer` of UTF-8 bytes so the JS side can pass it straight to
/// Ed25519 sign/verify without re-encoding.
#[napi]
pub fn canonicalize(value: Value) -> Buffer {
    let canonical = core_canonicalize(&value);
    canonical.into_bytes().into()
}

/// Stable JSON of `value` with NO stripping. Used by callers that want the
/// raw stable form (the JS `stable()` returns a JS object; this returns the
/// stringified bytes directly).
#[napi]
pub fn stable(value: Value) -> Buffer {
    stable_string(&value).into_bytes().into()
}

/// Sign an envelope. Loads the PKCS#8 PEM key at `keyPath`, recomputes
/// canonical bytes (with top-level `signature` stripped), and returns the
/// envelope object with `signature` populated as a base64 string.
#[napi]
pub fn sign(envelope: Value, key_path: String) -> Result<Value> {
    let mut obj = match envelope {
        Value::Object(map) => map,
        _ => return Err(invalid("envelope must be an object")),
    };

    let pem = fs::read_to_string(Path::new(&key_path))
        .map_err(|e| io_err(format!("failed to read key {key_path}: {e}")))?;
    let key = SigningKey::from_pkcs8_pem(&pem)
        .map_err(|e| invalid(format!("malformed PKCS#8 PEM in {key_path}: {e}")))?;

    // Clear any existing signature so canonicalize sees a clean envelope.
    obj.insert("signature".into(), Value::String(String::new()));
    let canonical = core_canonicalize(&Value::Object(obj.clone()));
    let sig = DalekSigner::sign(&key, canonical.as_bytes());
    obj.insert(
        "signature".into(),
        Value::String(BASE64_STANDARD.encode(sig.to_bytes())),
    );
    Ok(Value::Object(obj))
}

/// Verify an envelope's signature against a raw 32-byte Ed25519 public key.
/// Returns `true` if the canonical bytes (envelope minus top-level signature)
/// verify under the supplied key. Returns `false` on any failure (missing
/// signature, malformed base64, signature mismatch, etc.) — the JS loader
/// translates that into the `{ valid, reason }` shape that envelope.js
/// exposes.
#[napi]
pub fn verify(envelope: Value, public_key: Buffer) -> Result<bool> {
    let obj = match &envelope {
        Value::Object(map) => map,
        _ => return Err(invalid("envelope must be an object")),
    };

    let sig_b64 = match obj.get("signature").and_then(Value::as_str) {
        Some(s) if !s.is_empty() => s,
        _ => return Ok(false),
    };
    let sig_bytes = match BASE64_STANDARD.decode(sig_b64.as_bytes()) {
        Ok(b) => b,
        Err(_) => return Ok(false),
    };
    let sig_arr: [u8; 64] = match sig_bytes.as_slice().try_into() {
        Ok(a) => a,
        Err(_) => return Ok(false),
    };
    let sig = Signature::from_bytes(&sig_arr);

    let raw: &[u8] = &public_key;
    let raw_arr: [u8; 32] = match raw.try_into() {
        Ok(a) => a,
        Err(_) => {
            return Err(invalid(format!(
                "publicKey must be 32 raw Ed25519 bytes, got {}",
                raw.len()
            )));
        }
    };
    let verifying_key = VerifyingKey::from_bytes(&raw_arr)
        .map_err(|e| invalid(format!("malformed Ed25519 public key: {e}")))?;

    let canonical = core_canonicalize(&envelope);
    Ok(DalekVerifier::verify(&verifying_key, canonical.as_bytes(), &sig).is_ok())
}
