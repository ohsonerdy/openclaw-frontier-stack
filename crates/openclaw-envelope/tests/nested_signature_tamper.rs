//! Regression test for audit finding H2: tampering with a NESTED
//! `body.signature` field MUST invalidate envelope verification.
//!
//! This is the Rust equivalent of
//! `src/signed-bus/test/nested-signature-tamper.test.js`.
//!
//! IMPORTANT: this test MUTATES `body.signature`, it does NOT delete it.
//! Deletion alone can pass against the broken implementation because both
//! `delete env.body.signature` on the verifier side and a recursive strip
//! in `canonicalize` remove the key — they cancel out. Only mutation forces
//! the canonical bytes to diverge.

use ed25519_dalek::pkcs8::{EncodePrivateKey, LineEnding};
use ed25519_dalek::SigningKey;
use openclaw_envelope::{canonicalize, Envelope, EnvelopeType, Signer, Verifier};
use std::fs;

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

fn setup_keys(dir: &std::path::Path, agent: &str) {
    fs::create_dir_all(dir).unwrap();
    let mut secret = [0u8; 32];
    getrandom::getrandom(&mut secret).expect("os rng");
    let signing = SigningKey::from_bytes(&secret);
    let pem = signing.to_pkcs8_pem(LineEnding::LF).unwrap();
    fs::write(dir.join(format!("{agent}.pem")), pem.as_bytes()).unwrap();
    let raw: [u8; 32] = signing.verifying_key().to_bytes();
    fs::write(
        dir.join(format!("{agent}.pub")),
        format!("{}\n", openssh_ed25519(&raw, agent)),
    )
    .unwrap();
}

#[test]
fn h2_nested_signature_mutation_breaks_verification() {
    let tmp = tempfile::tempdir().unwrap();
    let keys_dir = tmp.path().join("keys");
    setup_keys(&keys_dir, "alpha");

    // Build an envelope whose body contains a key literally named `signature`.
    let mut env = Envelope::with_id_and_timestamp(
        "alpha",
        "alpha",
        EnvelopeType::Observation,
        "h2-nested-signature",
        serde_json::json!({ "value": 1, "signature": "attached-evidence-original" }),
        "id-h2".to_string(),
        "2026-01-01T00:00:00.000Z".to_string(),
    )
    .unwrap();

    let signer = Signer::from_pem_file(&keys_dir.join("alpha.pem")).unwrap();
    signer.sign(&mut env).unwrap();

    // 1. The original envelope MUST verify.
    let verifier = Verifier::new(&keys_dir);
    let v1 = verifier.verify(&env);
    assert!(
        v1.is_valid(),
        "expected original envelope to verify, got reason: {}",
        v1.reason()
    );

    // 2. Mutate the nested body.signature (do NOT delete - see file header).
    let mut tampered = env.clone();
    let obj = tampered
        .body
        .as_object_mut()
        .expect("body must be an object for this test");
    obj.insert(
        "signature".to_string(),
        serde_json::Value::String("attached-evidence-forged".into()),
    );

    let v2 = verifier.verify(&tampered);
    assert!(
        !v2.is_valid(),
        "H2 fix regressed: nested body.signature was tampered without breaking verify"
    );
    assert_eq!(
        v2.reason(),
        "bad-signature",
        "expected reason 'bad-signature', got '{}'",
        v2.reason()
    );
}

#[test]
fn h2_canonical_form_strips_top_level_keeps_nested() {
    // The canonical form MUST preserve nested signature keys while stripping
    // the top-level signature. Equivalent to the bottom of the JS regression.
    let sample = serde_json::json!({
        "type": "OBSERVATION",
        "body": { "signature": "inner-evidence", "x": 1 },
        "signature": "outer-envelope-sig"
    });
    let canonical = canonicalize(&sample);
    assert!(
        !canonical.contains("\"signature\":\"outer-envelope-sig\""),
        "canonical form must strip top-level signature; got: {canonical}"
    );
    assert!(
        canonical.contains("\"signature\":\"inner-evidence\""),
        "canonical form must preserve nested body.signature; got: {canonical}"
    );
}
