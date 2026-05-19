//! End-to-end signing + verification using on-disk keys.
//!
//! This test stands up a temporary keys directory, writes a PKCS#8 PEM
//! private key plus an OpenSSH `ssh-ed25519` public key for an `alpha` agent,
//! signs an envelope, then verifies it.

use ed25519_dalek::pkcs8::{EncodePrivateKey, LineEnding};
use ed25519_dalek::SigningKey;
use openclaw_envelope::{canonicalize, Envelope, EnvelopeType, Signer, Verifier};
use std::fs;

/// Encode a 32-byte Ed25519 raw public key as OpenSSH `ssh-ed25519 <base64> <comment>`.
fn openssh_ed25519(raw: &[u8; 32], comment: &str) -> String {
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine;
    let algo = b"ssh-ed25519";
    let mut blob = Vec::with_capacity(4 + algo.len() + 4 + 32);
    blob.extend_from_slice(&(algo.len() as u32).to_be_bytes());
    blob.extend_from_slice(algo);
    blob.extend_from_slice(&(32u32).to_be_bytes());
    blob.extend_from_slice(raw);
    format!("ssh-ed25519 {} {}", B64.encode(blob), comment)
}

fn setup_keypair(dir: &std::path::Path, agent: &str) -> SigningKey {
    fs::create_dir_all(dir).unwrap();
    // Build a 32-byte secret from the OS RNG.
    let mut secret = [0u8; 32];
    getrandom::getrandom(&mut secret).expect("os rng");
    let signing = SigningKey::from_bytes(&secret);
    let pem = signing
        .to_pkcs8_pem(LineEnding::LF)
        .expect("encode pkcs8");
    let priv_path = dir.join(format!("{agent}.pem"));
    fs::write(&priv_path, pem.as_bytes()).unwrap();
    let verifying = signing.verifying_key();
    let raw: [u8; 32] = verifying.to_bytes();
    let pub_line = openssh_ed25519(&raw, agent);
    let pub_path = dir.join(format!("{agent}.pub"));
    fs::write(&pub_path, format!("{pub_line}\n")).unwrap();
    signing
}

#[test]
fn sign_and_verify_round_trip() {
    let tmp = tempfile::tempdir().unwrap();
    let keys_dir = tmp.path().join("keys");
    let _key = setup_keypair(&keys_dir, "alpha");

    let mut env = Envelope::with_id_and_timestamp(
        "alpha",
        "beta",
        EnvelopeType::Observation,
        "demo-subject",
        serde_json::json!({ "value": 42 }),
        "id-1234".to_string(),
        "2026-01-01T00:00:00.000Z".to_string(),
    )
    .unwrap();

    let signer = Signer::from_pem_file(&keys_dir.join("alpha.pem")).unwrap();
    signer.sign(&mut env).unwrap();
    assert!(!env.signature.is_empty(), "signature must be populated");

    let verifier = Verifier::new(&keys_dir);
    let result = verifier.verify(&env);
    assert!(
        result.is_valid(),
        "expected valid signature, got reason: {}",
        result.reason()
    );
}

#[test]
fn tampered_body_fails_verification() {
    let tmp = tempfile::tempdir().unwrap();
    let keys_dir = tmp.path().join("keys");
    setup_keypair(&keys_dir, "alpha");

    let mut env = Envelope::with_id_and_timestamp(
        "alpha",
        "beta",
        EnvelopeType::Fact,
        "tamper-test",
        serde_json::json!({ "value": 1 }),
        "id-tamper".to_string(),
        "2026-01-01T00:00:00.000Z".to_string(),
    )
    .unwrap();

    let signer = Signer::from_pem_file(&keys_dir.join("alpha.pem")).unwrap();
    signer.sign(&mut env).unwrap();

    // Tamper with body after signing.
    env.body = serde_json::json!({ "value": 999 });

    let verifier = Verifier::new(&keys_dir);
    let result = verifier.verify(&env);
    assert!(!result.is_valid(), "tampered body must fail verification");
    assert_eq!(result.reason(), "bad-signature");
}

#[test]
fn missing_signature_is_reported() {
    let tmp = tempfile::tempdir().unwrap();
    let keys_dir = tmp.path().join("keys");
    setup_keypair(&keys_dir, "alpha");

    let env = Envelope::with_id_and_timestamp(
        "alpha",
        "beta",
        EnvelopeType::Heartbeat,
        "no-sig",
        serde_json::json!({}),
        "id-nosig".to_string(),
        "2026-01-01T00:00:00.000Z".to_string(),
    )
    .unwrap();

    let verifier = Verifier::new(&keys_dir);
    assert_eq!(verifier.verify(&env).reason(), "missing-signature");
}

#[test]
fn missing_public_key_is_reported() {
    let tmp = tempfile::tempdir().unwrap();
    let keys_dir = tmp.path().join("keys");
    fs::create_dir_all(&keys_dir).unwrap();

    let mut env = Envelope::with_id_and_timestamp(
        "alpha",
        "beta",
        EnvelopeType::Banter,
        "no-pub",
        serde_json::json!({}),
        "id-nopub".to_string(),
        "2026-01-01T00:00:00.000Z".to_string(),
    )
    .unwrap();
    env.signature = "AAAA".to_string();

    let verifier = Verifier::new(&keys_dir);
    let reason = verifier.verify(&env).reason().to_string();
    assert_eq!(reason, "no-public-key-for-alpha");
}

#[test]
fn canonical_form_used_for_signing_matches_expected_bytes() {
    // Deterministic envelope: build a known-good canonical-byte target and
    // verify that `canonicalize` produces it.
    let env = Envelope::with_id_and_timestamp(
        "alpha",
        "beta",
        EnvelopeType::Decision,
        "sample",
        serde_json::json!({ "k": "v" }),
        "id-canonical".to_string(),
        "2026-01-01T00:00:00.000Z".to_string(),
    )
    .unwrap();
    let value = serde_json::to_value(&env).unwrap();
    let canonical = canonicalize(&value);
    // Expected: keys sorted alphabetically; `signature` (empty string) stripped.
    let expected = concat!(
        "{",
        "\"body\":{\"k\":\"v\"},",
        "\"from\":\"alpha\",",
        "\"id\":\"id-canonical\",",
        "\"lineage\":[],",
        "\"schema\":\"openclaw-frontier.envelope.v1\",",
        "\"subject\":\"sample\",",
        "\"timestamp\":\"2026-01-01T00:00:00.000Z\",",
        "\"to\":\"beta\",",
        "\"type\":\"DECISION\"",
        "}"
    );
    assert_eq!(canonical, expected);
}
