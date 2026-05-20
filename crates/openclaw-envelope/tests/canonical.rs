//! Canonical-JSON round-trip tests.
//!
//! The fixture at `tests/fixtures/canonical-corpus.json` is a corpus of
//! `{ name, input, canonical }` triples whose `canonical` field was produced
//! by `envelope.js#canonicalize()` running on Node 24. Each triple is a hard
//! oracle: the Rust `canonicalize` MUST return the exact same bytes as the
//! `canonical` string.

use openclaw_envelope::canonicalize;
use serde_json::Value;
use std::path::PathBuf;

#[derive(serde::Deserialize)]
struct Corpus {
    name: String,
    input: Value,
    canonical: String,
}

fn load_corpus() -> Vec<Corpus> {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("tests");
    path.push("fixtures");
    path.push("canonical-corpus.json");
    let text = std::fs::read_to_string(&path).expect("read fixture");
    serde_json::from_str(&text).expect("parse fixture")
}

#[test]
fn fixture_corpus_matches_node_canonical_output() {
    let corpus = load_corpus();
    assert!(!corpus.is_empty(), "corpus must have entries");
    let mut failures = Vec::new();
    for entry in &corpus {
        let actual = canonicalize(&entry.input);
        if actual != entry.canonical {
            failures.push(format!(
                "  {}\n    expected: {}\n    actual:   {}",
                entry.name, entry.canonical, actual
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} corpus entries failed:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn top_level_signature_is_stripped() {
    let v: Value =
        serde_json::from_str(r#"{ "a": 1, "signature": "should-be-dropped" }"#).unwrap();
    assert_eq!(canonicalize(&v), r#"{"a":1}"#);
}

#[test]
fn nested_signature_is_preserved() {
    let v: Value = serde_json::from_str(
        r#"{ "body": { "signature": "inner" }, "signature": "outer" }"#,
    )
    .unwrap();
    // outer dropped, inner kept
    assert_eq!(canonicalize(&v), r#"{"body":{"signature":"inner"}}"#);
}

#[test]
fn keys_are_sorted_at_every_depth() {
    let v: Value = serde_json::from_str(
        r#"{ "z": { "b": 2, "a": 1 }, "m": [{"y": 1, "x": 2}], "a": 0 }"#,
    )
    .unwrap();
    assert_eq!(
        canonicalize(&v),
        r#"{"a":0,"m":[{"x":2,"y":1}],"z":{"a":1,"b":2}}"#
    );
}

#[test]
fn unicode_passes_through() {
    let v: Value = serde_json::json!({ "s": "café" });
    let canonical = canonicalize(&v);
    assert_eq!(canonical, r#"{"s":"café"}"#);
}

#[test]
fn control_chars_use_u_escape() {
    let v: Value = serde_json::json!({ "s": "\u{0001}\u{001f}" });
    // The canonical form escapes each control byte as `\u00XX`.
    assert_eq!(canonicalize(&v), "{\"s\":\"\\u0001\\u001f\"}");
}

#[test]
fn newline_tab_backslash_quote_use_short_escapes() {
    let v: Value = serde_json::json!({ "s": "a\nb\tc\\d\"e" });
    let canonical = canonicalize(&v);
    assert_eq!(canonical, "{\"s\":\"a\\nb\\tc\\\\d\\\"e\"}");
}
