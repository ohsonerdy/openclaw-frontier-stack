//! Path-claim collision detection.

use openclaw_blackboard::{BlackboardError, Ledger, LedgerOptions};

fn make_ledger(tmp: &std::path::Path) -> Ledger {
    Ledger::open(LedgerOptions::new(tmp.join("blackboard.jsonl")))
}

#[test]
fn second_agent_cannot_claim_already_held_path() {
    let tmp = tempfile::tempdir().unwrap();
    let ledger = make_ledger(tmp.path());

    ledger
        .claim_path("alice", "task.a", "src/foo.rs", "write", "")
        .expect("first claim succeeds");

    let err = ledger
        .claim_path("bob", "task.b", "src/foo.rs", "write", "")
        .expect_err("collision must be reported");

    match err {
        BlackboardError::PathClaimed { path, agent, task_id } => {
            assert_eq!(path, "src/foo.rs");
            assert_eq!(agent, "alice");
            assert_eq!(task_id, "task.a");
        }
        other => panic!("expected PathClaimed, got {other:?}"),
    }
}

#[test]
fn same_agent_and_task_can_reclaim_their_own_path() {
    let tmp = tempfile::tempdir().unwrap();
    let ledger = make_ledger(tmp.path());

    ledger
        .claim_path("alice", "task.a", "src/foo.rs", "write", "")
        .expect("first claim");
    ledger
        .claim_path("alice", "task.a", "src/foo.rs", "write", "refresh")
        .expect("self-reclaim should succeed");
}

#[test]
fn release_then_reclaim_by_other_agent_succeeds() {
    let tmp = tempfile::tempdir().unwrap();
    let ledger = make_ledger(tmp.path());

    ledger
        .claim_path("alice", "task.a", "src/foo.rs", "write", "")
        .unwrap();
    ledger
        .release_path("alice", "task.a", "src/foo.rs", "done")
        .unwrap();
    ledger
        .claim_path("bob", "task.b", "src/foo.rs", "write", "")
        .expect("post-release claim by another agent should succeed");
}

#[test]
fn secret_like_path_segments_are_rejected() {
    let tmp = tempfile::tempdir().unwrap();
    let ledger = make_ledger(tmp.path());
    let err = ledger
        .claim_path("alice", "task.a", "config/secret/keys.json", "write", "")
        .expect_err("secret-like path must be rejected");
    assert!(matches!(err, BlackboardError::Validation(_)));
}

#[test]
fn absolute_paths_are_rejected() {
    let tmp = tempfile::tempdir().unwrap();
    let ledger = make_ledger(tmp.path());
    let err = ledger
        .claim_path("alice", "task.a", "/etc/foo.conf", "write", "")
        .expect_err("absolute path must be rejected");
    assert!(matches!(err, BlackboardError::Validation(_)));
}

#[test]
fn parent_segments_are_rejected() {
    let tmp = tempfile::tempdir().unwrap();
    let ledger = make_ledger(tmp.path());
    let err = ledger
        .claim_path("alice", "task.a", "src/../leak.rs", "write", "")
        .expect_err("dotdot must be rejected");
    assert!(matches!(err, BlackboardError::Validation(_)));
}
