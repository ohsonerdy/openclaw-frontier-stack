//! OpenClaw Frontier Stack signed envelope.
//!
//! This crate mirrors `src/signed-bus/lib/envelope.js`. A signed envelope is a
//! JSON object carrying inter-agent messages on the OpenClaw bus. The signing
//! contract is:
//!
//! 1. Compute the canonical JSON form of the envelope, dropping the top-level
//!    `signature` field.
//! 2. Sign those exact bytes with Ed25519.
//! 3. Base64-encode the signature and place it back in the envelope as
//!    `signature`.
//!
//! Verification reverses the process: parse the envelope, recompute the
//! canonical bytes, and verify against the sender's public key, which lives in
//! `keys/<from>.pub` in OpenSSH `ssh-ed25519` format.
//!
//! ## Byte-identical interop
//!
//! The canonical encoder in this crate is hand-written to match Node's
//! `JSON.stringify` output on objects whose keys are sorted lexicographically.
//! See [`canonicalize`] and the `canonical` tests for the exact contract.
//!
//! The H2 audit finding (nested `signature` keys must be part of the signed
//! bytes) is respected: only the **top-level** `signature` is stripped. A
//! `body.signature` key participates in the signature, so any mutation of it
//! invalidates verification.
//!
//! ## Example
//!
//! ```no_run
//! use openclaw_envelope::{Envelope, EnvelopeType, Signer, Verifier};
//! use std::path::Path;
//!
//! let mut env = Envelope::new(
//!     "alpha",
//!     "beta",
//!     EnvelopeType::Observation,
//!     "demo-subject",
//!     serde_json::json!({ "n": 1 }),
//! ).expect("valid envelope");
//!
//! let signer = Signer::from_pem_file(Path::new("keys/alpha.pem")).unwrap();
//! signer.sign(&mut env).unwrap();
//!
//! let verifier = Verifier::new(Path::new("keys"));
//! assert!(verifier.verify(&env).is_valid());
//! ```

#![forbid(unsafe_code)]
#![deny(missing_docs)]

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use ed25519_dalek::pkcs8::DecodePrivateKey;
use ed25519_dalek::{Signature, Signer as DalekSigner, SigningKey, Verifier as DalekVerifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

/// Schema string baked into every envelope. Same as `envelope.js`.
pub const SCHEMA: &str = "openclaw-frontier.envelope.v1";

/// Maximum allowed subject length, in characters. Matches `envelope.js`.
pub const MAX_SUBJECT_LENGTH: usize = 200;

/// Maximum allowed body size, in bytes of its JSON encoding. Matches
/// `envelope.js`.
pub const MAX_BODY_BYTES: usize = 32 * 1024;

/// All envelope kinds. Adding a value here is a breaking change to the v1
/// schema. Mirrors the `VALID_TYPES` set in `envelope.js`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EnvelopeType {
    /// Work assignment: do this.
    #[serde(rename = "TASK")]
    Task,
    /// Outcome of a task.
    #[serde(rename = "RESULT")]
    Result,
    /// Asserted truth or measurement.
    #[serde(rename = "FACT")]
    Fact,
    /// Recorded observation.
    #[serde(rename = "OBSERVATION")]
    Observation,
    /// Decision made by an agent.
    #[serde(rename = "DECISION")]
    Decision,
    /// Urgent notification.
    #[serde(rename = "ALERT")]
    Alert,
    /// Free-form conversation.
    #[serde(rename = "BANTER")]
    Banter,
    /// Liveness ping.
    #[serde(rename = "HEARTBEAT")]
    Heartbeat,
}

impl EnvelopeType {
    /// Wire-format string for this envelope type.
    pub fn as_str(self) -> &'static str {
        match self {
            EnvelopeType::Task => "TASK",
            EnvelopeType::Result => "RESULT",
            EnvelopeType::Fact => "FACT",
            EnvelopeType::Observation => "OBSERVATION",
            EnvelopeType::Decision => "DECISION",
            EnvelopeType::Alert => "ALERT",
            EnvelopeType::Banter => "BANTER",
            EnvelopeType::Heartbeat => "HEARTBEAT",
        }
    }

    /// Parse a wire string. Returns `None` if the string is not a known type.
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "TASK" => Some(EnvelopeType::Task),
            "RESULT" => Some(EnvelopeType::Result),
            "FACT" => Some(EnvelopeType::Fact),
            "OBSERVATION" => Some(EnvelopeType::Observation),
            "DECISION" => Some(EnvelopeType::Decision),
            "ALERT" => Some(EnvelopeType::Alert),
            "BANTER" => Some(EnvelopeType::Banter),
            "HEARTBEAT" => Some(EnvelopeType::Heartbeat),
            _ => None,
        }
    }
}

/// Errors produced by this crate.
#[derive(Debug, Error)]
pub enum EnvelopeError {
    /// A validation rule was violated (token shape, subject form, body limit,
    /// public-safety scan, etc.).
    #[error("invalid envelope: {0}")]
    Invalid(String),

    /// I/O error reading a key from disk.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    /// JSON parse failure on a key blob or envelope.
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    /// Public key on disk was malformed or wrong size.
    #[error("malformed public key: {0}")]
    MalformedPublicKey(String),

    /// Private key on disk was malformed.
    #[error("malformed private key: {0}")]
    MalformedPrivateKey(String),

    /// Base64 decoding failed (typically on signatures or pubkey blobs).
    #[error("base64 decode error: {0}")]
    Base64(String),

    /// Signature did not verify against the public key. The envelope was
    /// either tampered with or signed by a different key.
    #[error("signature verification failed: {0}")]
    Signature(String),
}

/// An OpenClaw signed envelope.
///
/// The `schema` field is always set to [`SCHEMA`]. `signature` is empty until
/// [`Signer::sign`] populates it.
///
/// Field order in this struct is alphabetical because serde_json with the
/// `preserve_order` feature emits fields in insertion order, but our canonical
/// encoder sorts keys recursively, so the in-memory layout is not part of the
/// signed contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Envelope {
    /// Recipient agent id (lowercase ASCII) or `*` for broadcast.
    pub to: String,
    /// Originating agent id (lowercase ASCII).
    pub from: String,
    /// Schema version identifier.
    pub schema: String,
    /// Random UUID v4 string.
    pub id: String,
    /// ISO-8601 timestamp of envelope creation.
    pub timestamp: String,
    /// Envelope kind.
    #[serde(rename = "type")]
    pub envelope_type: EnvelopeType,
    /// Route label (alnum and `._:-`).
    pub subject: String,
    /// Arbitrary JSON payload, public-safety-scanned at construction time.
    pub body: Value,
    /// Optional lineage breadcrumbs (parent envelope ids).
    pub lineage: Vec<String>,
    /// Base64-encoded Ed25519 detached signature over the canonical bytes.
    pub signature: String,
}

impl Envelope {
    /// Build a new envelope with a fresh UUID and the current UTC timestamp.
    /// The id and timestamp are filled by [`Self::with_id_and_timestamp`]; here
    /// the caller must supply them.
    ///
    /// Use this constructor when you want deterministic envelopes (for tests).
    /// In production, [`Self::new`] generates the id and timestamp for you.
    pub fn with_id_and_timestamp(
        from: &str,
        to: &str,
        envelope_type: EnvelopeType,
        subject: &str,
        body: Value,
        id: String,
        timestamp: String,
    ) -> Result<Self, EnvelopeError> {
        let from = validate_token(from, "from", false)?;
        let to = validate_token(to, "to", true)?;
        let subject = validate_subject(subject)?;
        // Mirror the JS behavior: `null` / unset body becomes an empty object.
        let body = if body.is_null() {
            Value::Object(serde_json::Map::new())
        } else {
            body
        };
        validate_body(&body)?;
        Ok(Envelope {
            id,
            timestamp,
            schema: SCHEMA.to_string(),
            from,
            to,
            envelope_type,
            subject,
            body,
            lineage: Vec::new(),
            signature: String::new(),
        })
    }

    /// Build a new envelope with a non-deterministic id and timestamp.
    ///
    /// The id is a random 32-hex-char string (not a real UUID v4 with version
    /// bits — the JS side uses `crypto.randomUUID` which yields a real UUID;
    /// callers needing the canonical form can use
    /// [`Self::with_id_and_timestamp`] and pass in their own ids).
    pub fn new(
        from: &str,
        to: &str,
        envelope_type: EnvelopeType,
        subject: &str,
        body: Value,
    ) -> Result<Self, EnvelopeError> {
        Self::with_id_and_timestamp(
            from,
            to,
            envelope_type,
            subject,
            body,
            random_hex_id(),
            iso_now_utc(),
        )
    }

    /// Validate the lineage list in place. Used internally by verification.
    fn validate_lineage(&self) -> Result<(), EnvelopeError> {
        for id in &self.lineage {
            if !is_lineage_id(id) {
                return Err(EnvelopeError::Invalid(
                    "lineage ids must be simple identifiers".into(),
                ));
            }
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------

/// Compute the canonical JSON encoding of an envelope payload.
///
/// This mirrors `envelope.js#canonicalize`: the top-level `signature` field is
/// stripped, all object keys are sorted lexicographically at every depth, and
/// the encoding matches Node's `JSON.stringify` output byte-for-byte for the
/// subset of values produced by the OpenClaw runtime (no NaN, no Infinity).
///
/// The H2 fix is honored here: only the **top-level** `signature` is stripped.
/// A `body.signature` key is preserved in the canonical bytes.
pub fn canonicalize(value: &Value) -> String {
    let mut out = String::new();
    match value {
        Value::Object(_) => {
            // Top-level object: strip `signature`.
            let map = sort_object_strip_top(value);
            emit_sorted_object(&map, &mut out);
        }
        _ => emit_value(value, &mut out),
    }
    out
}

/// Convert a JSON object to a BTreeMap (sorted by key), stripping a top-level
/// `signature` key if present. Inner objects are NOT recursively stripped —
/// that is the H2 fix.
fn sort_object_strip_top(value: &Value) -> BTreeMap<String, &Value> {
    let mut map = BTreeMap::new();
    if let Value::Object(obj) = value {
        for (k, v) in obj {
            if k == "signature" {
                continue;
            }
            map.insert(k.clone(), v);
        }
    }
    map
}

fn emit_value(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => emit_number(n, out),
        Value::String(s) => emit_string(s, out),
        Value::Array(arr) => emit_array(arr, out),
        Value::Object(obj) => {
            // Nested objects: keep all keys (including any literal "signature"),
            // but sort by key.
            let mut sorted: BTreeMap<&str, &Value> = BTreeMap::new();
            for (k, v) in obj {
                sorted.insert(k.as_str(), v);
            }
            out.push('{');
            let mut first = true;
            for (k, v) in sorted.iter() {
                if !first {
                    out.push(',');
                }
                first = false;
                emit_string(*k, out);
                out.push(':');
                emit_value(*v, out);
            }
            out.push('}');
        }
    }
}

fn emit_sorted_object(map: &BTreeMap<String, &Value>, out: &mut String) {
    out.push('{');
    let mut first = true;
    for (k, v) in map.iter() {
        if !first {
            out.push(',');
        }
        first = false;
        emit_string(k.as_str(), out);
        out.push(':');
        emit_value(*v, out);
    }
    out.push('}');
}

fn emit_array(arr: &[Value], out: &mut String) {
    out.push('[');
    let mut first = true;
    for v in arr {
        if !first {
            out.push(',');
        }
        first = false;
        emit_value(v, out);
    }
    out.push(']');
}

fn emit_number(n: &serde_json::Number, out: &mut String) {
    // For integers serde_json emits "42"; for floats it emits the shortest
    // round-trip representation. That matches Node's behavior for the
    // integer-and-1.5 case in the test corpus. Edge cases like very large
    // floats can diverge between Node and Rust, but those are out of scope
    // for the v0.7.0 MVP — envelope bodies are typically ids and strings.
    out.push_str(&n.to_string());
}

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
            // Other C0 controls: \u00XX
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            // All other characters (including non-ASCII printable Unicode,
            // U+2028, U+2029, astrals) pass through as their UTF-8 bytes —
            // this matches Node's JSON.stringify.
            c => out.push(c),
        }
    }
    out.push('"');
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

fn validate_token(value: &str, field: &str, allow_broadcast: bool) -> Result<String, EnvelopeError> {
    let trimmed = value.trim();
    if allow_broadcast && trimmed == "*" {
        return Ok("*".to_string());
    }
    if trimmed.is_empty() || trimmed.len() > 64 {
        return Err(EnvelopeError::Invalid(format!(
            "{field} must be a simple agent id"
        )));
    }
    let mut chars = trimmed.chars();
    let first = chars.next().unwrap();
    if !first.is_ascii_alphabetic() {
        return Err(EnvelopeError::Invalid(format!(
            "{field} must be a simple agent id"
        )));
    }
    for c in chars {
        if !(c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            return Err(EnvelopeError::Invalid(format!(
                "{field} must be a simple agent id"
            )));
        }
    }
    Ok(trimmed.to_ascii_lowercase())
}

fn validate_subject(value: &str) -> Result<String, EnvelopeError> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_SUBJECT_LENGTH {
        return Err(EnvelopeError::Invalid(format!(
            "subject must be 1-{MAX_SUBJECT_LENGTH} characters"
        )));
    }
    let mut chars = trimmed.chars();
    let first = chars.next().unwrap();
    if !first.is_ascii_alphanumeric() {
        return Err(EnvelopeError::Invalid(
            "subject must be a simple route label".into(),
        ));
    }
    for c in chars {
        if !(c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-')) {
            return Err(EnvelopeError::Invalid(
                "subject must be a simple route label".into(),
            ));
        }
    }
    Ok(trimmed.to_string())
}

fn is_lineage_id(s: &str) -> bool {
    if s.is_empty() || s.len() > 128 {
        return false;
    }
    let mut chars = s.chars();
    let first = chars.next().unwrap();
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

fn validate_body(body: &Value) -> Result<(), EnvelopeError> {
    // Serialize with Node-compatible JSON (no pretty-printing) and check size.
    let text = serde_json::to_string(body)?;
    if text.len() > MAX_BODY_BYTES {
        return Err(EnvelopeError::Invalid(format!(
            "body exceeds {MAX_BODY_BYTES} bytes"
        )));
    }
    public_safety_scan(&text)
}

fn public_safety_scan(text: &str) -> Result<(), EnvelopeError> {
    // These are coarse anchor checks; the JS side uses regexes. We mirror the
    // patterns by hand so we don't take a `regex` dependency.

    if text.contains("-----BEGIN ") && text.contains("PRIVATE KEY-----") {
        return Err(EnvelopeError::Invalid(
            "body failed production-safety scan: private-key".into(),
        ));
    }
    if has_home_path(text) {
        return Err(EnvelopeError::Invalid(
            "body failed production-safety scan: home-path".into(),
        ));
    }
    if has_api_token(text) {
        return Err(EnvelopeError::Invalid(
            "body failed production-safety scan: api-token".into(),
        ));
    }
    if has_rfc1918_ipv4(text) || has_cgnat_ipv4(text) {
        return Err(EnvelopeError::Invalid(
            "body failed production-safety scan: ipv4-address".into(),
        ));
    }
    Ok(())
}

fn has_home_path(text: &str) -> bool {
    // POSIX:  /Users/<name>
    if let Some(pos) = text.find("/Users/") {
        let rest = &text[pos + "/Users/".len()..];
        if rest.chars().next().is_some_and(is_user_segment_char) {
            return true;
        }
    }
    // Windows: <drive>:\Users\<name>
    let bytes = text.as_bytes();
    for i in 0..bytes.len().saturating_sub(8) {
        let c = bytes[i];
        if !c.is_ascii_alphabetic() {
            continue;
        }
        if bytes[i + 1] == b':' && bytes[i + 2] == b'\\' {
            let tail = &text[i + 3..];
            if tail.starts_with("Users\\") {
                let after = &tail["Users\\".len()..];
                if after.chars().next().is_some_and(is_user_segment_char) {
                    return true;
                }
            }
        }
    }
    false
}

fn is_user_segment_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')
}

fn has_api_token(text: &str) -> bool {
    // sk-<20+>, ghp_<20+>, github_pat_<20+>, xox[abpors]-<20+>
    for prefix in ["sk-", "ghp_", "github_pat_", "xoxa-", "xoxb-", "xoxp-", "xoxo-", "xoxr-", "xoxs-"] {
        let bytes = text.as_bytes();
        let mut start = 0;
        while let Some(rel) = text[start..].find(prefix) {
            let pos = start + rel;
            let left_boundary = pos == 0 || !is_word_byte(bytes[pos - 1]);
            if left_boundary {
                let tail = &text[pos + prefix.len()..];
                let run = tail
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
                    .count();
                if run >= 20 {
                    return true;
                }
            }
            start = pos + prefix.len();
        }
    }
    false
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn has_rfc1918_ipv4(text: &str) -> bool {
    has_ipv4_with_prefix(text, &["10.", "192.168."]) || has_172_block(text)
}

fn has_172_block(text: &str) -> bool {
    // 172.(16..=31).x.y
    for prefix in 16..=31 {
        let pat = format!("172.{prefix}.");
        if let Some(pos) = text.find(&pat) {
            let tail = &text[pos + pat.len()..];
            if tail
                .split('.')
                .take(2)
                .all(|p| !p.is_empty() && p.chars().take(3).all(|c| c.is_ascii_digit()))
            {
                return true;
            }
        }
    }
    false
}

fn has_cgnat_ipv4(text: &str) -> bool {
    // 100.(64..=127).x.y
    for prefix in 64..=127 {
        let pat = format!("100.{prefix}.");
        if let Some(pos) = text.find(&pat) {
            let tail = &text[pos + pat.len()..];
            if tail
                .split('.')
                .take(2)
                .all(|p| !p.is_empty() && p.chars().take(3).all(|c| c.is_ascii_digit()))
            {
                return true;
            }
        }
    }
    false
}

fn has_ipv4_with_prefix(text: &str, prefixes: &[&str]) -> bool {
    for pre in prefixes {
        if let Some(pos) = text.find(*pre) {
            let tail = &text[pos + pre.len()..];
            // Require at least two more dot-separated digit runs after the
            // prefix to call this a real IPv4 address.
            if tail
                .split('.')
                .take(if pre == &"10." { 3 } else { 2 })
                .all(|p| !p.is_empty() && p.chars().take(3).all(|c| c.is_ascii_digit()))
            {
                return true;
            }
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/// Holds an Ed25519 signing key loaded from a PKCS#8 PEM file.
pub struct Signer {
    key: SigningKey,
}

impl Signer {
    /// Load a signing key from a PKCS#8 PEM file produced by Node's
    /// `crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' })`.
    pub fn from_pem_file(path: &Path) -> Result<Self, EnvelopeError> {
        let pem = fs::read_to_string(path)?;
        let key = SigningKey::from_pkcs8_pem(&pem)
            .map_err(|e| EnvelopeError::MalformedPrivateKey(e.to_string()))?;
        Ok(Signer { key })
    }

    /// Sign the envelope in place. Sets `signature` to the base64-encoded
    /// detached Ed25519 signature over the canonical bytes.
    pub fn sign(&self, envelope: &mut Envelope) -> Result<(), EnvelopeError> {
        envelope.signature.clear();
        let json = serde_json::to_value(&*envelope)?;
        let canonical = canonicalize(&json);
        let sig = DalekSigner::sign(&self.key, canonical.as_bytes());
        envelope.signature = BASE64_STANDARD.encode(sig.to_bytes());
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/// Outcome of [`Verifier::verify`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyOutcome {
    /// Signature was valid for the given envelope.
    Valid,
    /// Verification failed. The string is a stable machine-readable reason
    /// matching the JS side's reason strings (e.g. `bad-signature`,
    /// `missing-signature`).
    Invalid(String),
}

impl VerifyOutcome {
    /// Returns true if this is [`VerifyOutcome::Valid`].
    pub fn is_valid(&self) -> bool {
        matches!(self, VerifyOutcome::Valid)
    }

    /// Returns the reason string. For [`VerifyOutcome::Valid`] returns `"ok"`.
    pub fn reason(&self) -> &str {
        match self {
            VerifyOutcome::Valid => "ok",
            VerifyOutcome::Invalid(s) => s.as_str(),
        }
    }
}

/// Verifies envelope signatures using public keys on disk.
///
/// Public keys are loaded lazily from `<keys_dir>/<from>.pub` in OpenSSH
/// `ssh-ed25519` format.
pub struct Verifier {
    keys_dir: PathBuf,
}

impl Verifier {
    /// Construct a verifier rooted at `keys_dir`.
    pub fn new(keys_dir: &Path) -> Self {
        Verifier {
            keys_dir: keys_dir.to_path_buf(),
        }
    }

    /// Verify an envelope's signature.
    pub fn verify(&self, envelope: &Envelope) -> VerifyOutcome {
        if envelope.signature.is_empty() {
            return VerifyOutcome::Invalid("missing-signature".into());
        }
        if !envelope.schema.is_empty() && envelope.schema != SCHEMA {
            return VerifyOutcome::Invalid("invalid-schema".into());
        }
        if let Err(e) = envelope.validate_lineage() {
            return VerifyOutcome::Invalid(format!("invalid-envelope:{e}"));
        }
        if let Err(e) = validate_body(&envelope.body) {
            return VerifyOutcome::Invalid(format!("invalid-envelope:{e}"));
        }

        let pub_key = match self.load_public_key(&envelope.from) {
            Ok(Some(k)) => k,
            Ok(None) => {
                return VerifyOutcome::Invalid(format!(
                    "no-public-key-for-{}",
                    envelope.from
                ));
            }
            Err(e) => return VerifyOutcome::Invalid(format!("verify-error:{e}")),
        };

        let sig_bytes = match BASE64_STANDARD.decode(envelope.signature.as_bytes()) {
            Ok(b) => b,
            Err(_) => return VerifyOutcome::Invalid("bad-signature".into()),
        };
        let sig_array: [u8; 64] = match sig_bytes.as_slice().try_into() {
            Ok(a) => a,
            Err(_) => return VerifyOutcome::Invalid("bad-signature".into()),
        };
        let sig = Signature::from_bytes(&sig_array);

        // Build canonical bytes from the envelope minus its signature.
        let json = match serde_json::to_value(envelope) {
            Ok(v) => v,
            Err(e) => return VerifyOutcome::Invalid(format!("verify-error:{e}")),
        };
        let canonical = canonicalize(&json);

        match DalekVerifier::verify(&pub_key, canonical.as_bytes(), &sig) {
            Ok(()) => VerifyOutcome::Valid,
            Err(_) => VerifyOutcome::Invalid("bad-signature".into()),
        }
    }

    /// Load a public key from disk. Returns `Ok(None)` if the file is missing
    /// (mirrors the JS behavior of treating a missing key as a soft failure).
    pub fn load_public_key(&self, from: &str) -> Result<Option<VerifyingKey>, EnvelopeError> {
        let path = self.keys_dir.join(format!("{from}.pub"));
        if !path.exists() {
            return Ok(None);
        }
        let text = fs::read_to_string(&path)?;
        let line = text.lines().next().unwrap_or("").trim();
        let mut parts = line.split_whitespace();
        let algo = parts.next().unwrap_or("");
        let blob_b64 = parts.next().unwrap_or("");
        if algo != "ssh-ed25519" {
            return Err(EnvelopeError::MalformedPublicKey(format!(
                "{} is not an ssh-ed25519 key",
                path.display()
            )));
        }
        let blob = BASE64_STANDARD
            .decode(blob_b64.as_bytes())
            .map_err(|e| EnvelopeError::Base64(e.to_string()))?;
        let raw = decode_openssh_ed25519(&blob)?;
        let arr: [u8; 32] = raw.try_into().map_err(|v: Vec<u8>| {
            EnvelopeError::MalformedPublicKey(format!(
                "expected 32-byte Ed25519 key, got {}",
                v.len()
            ))
        })?;
        let key = VerifyingKey::from_bytes(&arr)
            .map_err(|e| EnvelopeError::MalformedPublicKey(e.to_string()))?;
        Ok(Some(key))
    }
}

/// Extract the 32-byte raw Ed25519 key from an OpenSSH wire-format blob.
///
/// Format: `[4-byte-len][algo "ssh-ed25519"][4-byte-len][32-byte raw key]`
fn decode_openssh_ed25519(blob: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
    if blob.len() < 4 {
        return Err(EnvelopeError::MalformedPublicKey(
            "openssh blob too short for algo length".into(),
        ));
    }
    let algo_len = u32::from_be_bytes([blob[0], blob[1], blob[2], blob[3]]) as usize;
    let key_offset = 4 + algo_len;
    if blob.len() < key_offset + 4 {
        return Err(EnvelopeError::MalformedPublicKey(
            "openssh blob too short for key length".into(),
        ));
    }
    let key_len = u32::from_be_bytes([
        blob[key_offset],
        blob[key_offset + 1],
        blob[key_offset + 2],
        blob[key_offset + 3],
    ]) as usize;
    if blob.len() < key_offset + 4 + key_len {
        return Err(EnvelopeError::MalformedPublicKey(
            "openssh blob too short for key body".into(),
        ));
    }
    Ok(blob[key_offset + 4..key_offset + 4 + key_len].to_vec())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn random_hex_id() -> String {
    // 16 random bytes as hex. Not a proper UUID v4 (no version/variant bits),
    // but the wire format only requires a unique opaque id string. Tests
    // requiring a stable id should use `with_id_and_timestamp`.
    let mut bytes = [0u8; 16];
    fill_random(&mut bytes);
    let mut s = String::with_capacity(32);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

fn fill_random(buf: &mut [u8]) {
    // Pull from the OS RNG via `getrandom`. Falls back to a time-seeded
    // xorshift only if getrandom fails (extremely unlikely on any supported
    // platform, but the function is infallible by contract).
    if getrandom::getrandom(buf).is_ok() {
        return;
    }
    let mut state = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0xdead_beef);
    for byte in buf.iter_mut() {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        *byte = state as u8;
    }
}

fn iso_now_utc() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    let millis = dur.subsec_millis();
    // Days from civil-date algorithm.
    let days = (secs / 86_400) as i64;
    let (year, month, day) = days_to_ymd(days);
    let sod = (secs % 86_400) as u32;
    let hour = sod / 3600;
    let min = (sod % 3600) / 60;
    let sec = sod % 60;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year, month, day, hour, min, sec, millis
    )
}

/// Howard Hinnant's civil_from_days, adapted for `days since 1970-01-01`.
fn days_to_ymd(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = if m <= 2 { y + 1 } else { y };
    (year as i32, m as u32, d as u32)
}

