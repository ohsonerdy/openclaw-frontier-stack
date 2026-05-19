//! Append + read-back round-trip tests for the ledger.

use openclaw_blackboard::{Ledger, LedgerOptions, RecordKind};

fn make_ledger(tmp: &std::path::Path) -> Ledger {
    Ledger::open(LedgerOptions::new(tmp.join("blackboard.jsonl")))
}

#[test]
fn append_then_read_returns_same_record() {
    let tmp = tempfile::tempdir().unwrap();
    let ledger = make_ledger(tmp.path());

    let record = ledger
        .claim_task("alice", "task.one", "warm up")
        .expect("claim succeeds");

    let read = ledger.read_records().expect("read records");
    assert_eq!(read.len(), 1);
    assert_eq!(read[0].kind, RecordKind::TaskClaim);
    assert_eq!(read[0].id, record.id);
    assert_eq!(read[0].get_str("agent"), Some("alice"));
    assert_eq!(read[0].get_str("taskId"), Some("task.one"));
    assert_eq!(read[0].get_str("summary"), Some("warm up"));
}

#[test]
fn jsonl_format_one_record_per_line_lf_only() {
    let tmp = tempfile::tempdir().unwrap();
    let ledger = make_ledger(tmp.path());
    ledger.claim_task("alice", "t.a", "a").unwrap();
    ledger.claim_task("bob", "t.b", "b").unwrap();

    let bytes = std::fs::read(ledger.ledger_path()).unwrap();
    let text = std::str::from_utf8(&bytes).unwrap();

    // Final byte must be `\n`.
    assert_eq!(bytes.last().copied(), Some(b'\n'));
    // No `\r` characters anywhere.
    assert!(!bytes.contains(&b'\r'), "ledger must use LF, not CRLF");
    // Exactly two non-empty lines.
    let non_empty: Vec<&str> = text.split('\n').filter(|l| !l.is_empty()).collect();
    assert_eq!(non_empty.len(), 2);
    // Each non-empty line is a parseable JSON object.
    for line in non_empty {
        let v: serde_json::Value = serde_json::from_str(line).expect("parse line");
        assert!(v.is_object());
    }
}

#[test]
fn record_fact_round_trips() {
    let tmp = tempfile::tempdir().unwrap();
    let ledger = make_ledger(tmp.path());
    ledger
        .record_fact(
            "alice",
            "system-name",
            serde_json::json!("frontier"),
            vec!["doc-1".into()],
        )
        .unwrap();
    let read = ledger.read_records().unwrap();
    assert_eq!(read.len(), 1);
    assert_eq!(read[0].kind, RecordKind::Fact);
    assert_eq!(read[0].get_str("subject"), Some("system-name"));
}

#[test]
fn invalid_agent_id_is_rejected() {
    let tmp = tempfile::tempdir().unwrap();
    let ledger = make_ledger(tmp.path());
    let err = ledger
        .claim_task("9-bad", "task.one", "summary")
        .expect_err("invalid id should fail");
    assert!(matches!(
        err,
        openclaw_blackboard::BlackboardError::Validation(_)
    ));
}

#[test]
fn empty_ledger_reads_as_empty_vec() {
    let tmp = tempfile::tempdir().unwrap();
    let ledger = make_ledger(tmp.path());
    let read = ledger.read_records().unwrap();
    assert!(read.is_empty());
}

#[test]
fn read_existing_jsonl_baked_oracle() {
    // Pre-built JSONL produced by the Node implementation: two task-claim
    // records terminated by `\n`. Bytes are baked in as a hex-decoded
    // string so the test does not depend on any external fixture file.
    let jsonl = "{\"schema\":\"openclaw-frontier.blackboard-ledger.v1\",\"id\":\"task-claim-1\",\"ts\":\"2026-01-01T00:00:00.000Z\",\"kind\":\"task-claim\",\"agent\":\"alpha\",\"taskId\":\"t.1\",\"summary\":\"first\",\"status\":\"claimed\"}\n{\"schema\":\"openclaw-frontier.blackboard-ledger.v1\",\"id\":\"task-claim-2\",\"ts\":\"2026-01-01T00:00:01.000Z\",\"kind\":\"task-claim\",\"agent\":\"beta\",\"taskId\":\"t.2\",\"summary\":\"second\",\"status\":\"claimed\"}\n";

    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("blackboard.jsonl");
    std::fs::write(&path, jsonl).unwrap();
    let ledger = Ledger::open(LedgerOptions::new(path));

    let records = ledger.read_records().unwrap();
    assert_eq!(records.len(), 2);
    assert_eq!(records[0].id, "task-claim-1");
    assert_eq!(records[1].id, "task-claim-2");
    assert_eq!(records[0].kind, RecordKind::TaskClaim);
    assert_eq!(records[0].get_str("agent"), Some("alpha"));
    assert_eq!(records[1].get_str("agent"), Some("beta"));
}
