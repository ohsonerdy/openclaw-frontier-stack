//! Snapshot reducer tests. Pre-built JSONL strings serve as oracles.

use openclaw_blackboard::{Ledger, LedgerOptions, RecordKind};

fn write_jsonl(tmp: &std::path::Path, body: &str) -> Ledger {
    let path = tmp.join("blackboard.jsonl");
    std::fs::write(&path, body).unwrap();
    Ledger::open(LedgerOptions::new(path))
}

#[test]
fn snapshot_reflects_task_lifecycle() {
    // 1. alice claims task t.x
    // 2. alice records ok result for t.x  =>  state should be `done`.
    let jsonl = "{\"schema\":\"openclaw-frontier.blackboard-ledger.v1\",\"id\":\"task-claim-1\",\"ts\":\"2026-01-01T00:00:00.000Z\",\"kind\":\"task-claim\",\"agent\":\"alice\",\"taskId\":\"t.x\",\"summary\":\"work\",\"status\":\"claimed\"}\n{\"schema\":\"openclaw-frontier.blackboard-ledger.v1\",\"id\":\"result-1\",\"ts\":\"2026-01-01T00:01:00.000Z\",\"kind\":\"result\",\"agent\":\"alice\",\"taskId\":\"t.x\",\"ok\":true,\"summary\":\"done\",\"artifacts\":[]}\n";

    let tmp = tempfile::tempdir().unwrap();
    let ledger = write_jsonl(tmp.path(), jsonl);
    let snap = ledger.snapshot().unwrap();

    let task = snap.tasks.get("t.x").expect("task present");
    assert_eq!(task.status, "done");
    assert_eq!(task.agent, "alice");
    assert_eq!(snap.results.len(), 1);
    assert_eq!(*snap.counts.get(&RecordKind::Result).unwrap(), 1);
    assert_eq!(*snap.counts.get(&RecordKind::TaskClaim).unwrap(), 1);
}

#[test]
fn snapshot_marks_failed_result_as_failed() {
    let jsonl = "{\"schema\":\"openclaw-frontier.blackboard-ledger.v1\",\"id\":\"task-claim-1\",\"ts\":\"2026-01-01T00:00:00.000Z\",\"kind\":\"task-claim\",\"agent\":\"alice\",\"taskId\":\"t.x\",\"summary\":\"work\",\"status\":\"claimed\"}\n{\"schema\":\"openclaw-frontier.blackboard-ledger.v1\",\"id\":\"result-1\",\"ts\":\"2026-01-01T00:01:00.000Z\",\"kind\":\"result\",\"agent\":\"alice\",\"taskId\":\"t.x\",\"ok\":false,\"summary\":\"crashed\",\"artifacts\":[]}\n";
    let tmp = tempfile::tempdir().unwrap();
    let ledger = write_jsonl(tmp.path(), jsonl);
    let snap = ledger.snapshot().unwrap();
    assert_eq!(snap.tasks.get("t.x").unwrap().status, "failed");
}

#[test]
fn snapshot_removes_path_claim_on_release() {
    let jsonl = "{\"schema\":\"openclaw-frontier.blackboard-ledger.v1\",\"id\":\"path-claim-1\",\"ts\":\"2026-01-01T00:00:00.000Z\",\"kind\":\"path-claim\",\"agent\":\"alice\",\"taskId\":\"t.x\",\"path\":\"src/foo.rs\",\"mode\":\"write\",\"reason\":\"\"}\n{\"schema\":\"openclaw-frontier.blackboard-ledger.v1\",\"id\":\"path-release-1\",\"ts\":\"2026-01-01T00:01:00.000Z\",\"kind\":\"path-release\",\"agent\":\"alice\",\"taskId\":\"t.x\",\"path\":\"src/foo.rs\",\"reason\":\"\"}\n";

    let tmp = tempfile::tempdir().unwrap();
    let ledger = write_jsonl(tmp.path(), jsonl);
    let snap = ledger.snapshot().unwrap();
    assert!(snap.path_claims.is_empty(), "release must clear the claim");
}

#[test]
fn snapshot_keeps_claim_when_release_owner_mismatches() {
    let jsonl = "{\"schema\":\"openclaw-frontier.blackboard-ledger.v1\",\"id\":\"path-claim-1\",\"ts\":\"2026-01-01T00:00:00.000Z\",\"kind\":\"path-claim\",\"agent\":\"alice\",\"taskId\":\"t.x\",\"path\":\"src/foo.rs\",\"mode\":\"write\",\"reason\":\"\"}\n{\"schema\":\"openclaw-frontier.blackboard-ledger.v1\",\"id\":\"path-release-1\",\"ts\":\"2026-01-01T00:01:00.000Z\",\"kind\":\"path-release\",\"agent\":\"bob\",\"taskId\":\"t.x\",\"path\":\"src/foo.rs\",\"reason\":\"\"}\n";

    let tmp = tempfile::tempdir().unwrap();
    let ledger = write_jsonl(tmp.path(), jsonl);
    let snap = ledger.snapshot().unwrap();
    assert!(
        snap.path_claims.contains_key("src/foo.rs"),
        "release by wrong owner must not clear claim"
    );
}

#[test]
fn empty_ledger_has_empty_snapshot() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("blackboard.jsonl");
    let ledger = Ledger::open(LedgerOptions::new(path));
    let snap = ledger.snapshot().unwrap();
    assert!(snap.tasks.is_empty());
    assert!(snap.path_claims.is_empty());
    assert!(snap.facts.is_empty());
    assert!(snap.counts.is_empty());
}
