//! Invalid-transition tests: terminal-state mutation, unknown task, and
//! bad input validation.

use openclaw_taskflow::{ResultStatus, TaskFlowError, TaskFlowRuntime};

#[test]
fn claim_after_done_is_rejected() {
    let mut rt = TaskFlowRuntime::new();
    rt.create_task(
        "t.done",
        "Title",
        "orchestrator",
        "normal",
        serde_json::json!({}),
        Vec::new(),
    )
    .unwrap();
    rt.claim_task("t.done", "alpha").unwrap();
    rt.complete_task("t.done", "alpha", ResultStatus::Ok, "done", Vec::new())
        .unwrap();
    let err = rt.claim_task("t.done", "alpha").expect_err("must reject");
    assert!(matches!(err, TaskFlowError::AlreadyTerminal { .. }));
}

#[test]
fn claim_after_failed_is_rejected() {
    let mut rt = TaskFlowRuntime::new();
    rt.create_task(
        "t.fail",
        "Title",
        "orchestrator",
        "normal",
        serde_json::json!({}),
        Vec::new(),
    )
    .unwrap();
    rt.claim_task("t.fail", "alpha").unwrap();
    rt.complete_task("t.fail", "alpha", ResultStatus::Failed, "oops", Vec::new())
        .unwrap();
    let err = rt.claim_task("t.fail", "alpha").expect_err("must reject");
    assert!(matches!(err, TaskFlowError::AlreadyTerminal { .. }));
}

#[test]
fn claim_unknown_task_is_not_found() {
    let mut rt = TaskFlowRuntime::new();
    let err = rt
        .claim_task("nope", "alpha")
        .expect_err("must reject unknown task");
    assert!(matches!(err, TaskFlowError::NotFound(_)));
}

#[test]
fn complete_unknown_task_is_not_found() {
    let mut rt = TaskFlowRuntime::new();
    let err = rt
        .complete_task("nope", "alpha", ResultStatus::Ok, "done", Vec::new())
        .expect_err("must reject unknown task");
    assert!(matches!(err, TaskFlowError::NotFound(_)));
}

#[test]
fn invalid_task_id_is_rejected() {
    let mut rt = TaskFlowRuntime::new();
    let err = rt
        .create_task(
            "!bad!",
            "Title",
            "orchestrator",
            "normal",
            serde_json::json!({}),
            Vec::new(),
        )
        .expect_err("must reject");
    assert!(matches!(err, TaskFlowError::Validation(_)));
}

#[test]
fn invalid_agent_id_is_rejected() {
    let mut rt = TaskFlowRuntime::new();
    rt.create_task(
        "t.x",
        "Title",
        "orchestrator",
        "normal",
        serde_json::json!({}),
        Vec::new(),
    )
    .unwrap();
    let err = rt
        .claim_task("t.x", "9-bad")
        .expect_err("must reject");
    assert!(matches!(err, TaskFlowError::Validation(_)));
}

#[test]
fn empty_summary_is_rejected_on_complete() {
    let mut rt = TaskFlowRuntime::new();
    rt.create_task(
        "t.y",
        "Title",
        "orchestrator",
        "normal",
        serde_json::json!({}),
        Vec::new(),
    )
    .unwrap();
    rt.claim_task("t.y", "alpha").unwrap();
    let err = rt
        .complete_task("t.y", "alpha", ResultStatus::Ok, "", Vec::new())
        .expect_err("must reject empty summary");
    assert!(matches!(err, TaskFlowError::Validation(_)));
}

#[test]
fn artifact_with_secret_keyword_is_rejected() {
    let mut rt = TaskFlowRuntime::new();
    rt.create_task(
        "t.z",
        "Title",
        "orchestrator",
        "normal",
        serde_json::json!({}),
        Vec::new(),
    )
    .unwrap();
    rt.claim_task("t.z", "alpha").unwrap();
    let err = rt
        .complete_task(
            "t.z",
            "alpha",
            ResultStatus::Ok,
            "done",
            vec!["config/secret/keys.json".into()],
        )
        .expect_err("must reject secret-like artifact path");
    assert!(matches!(err, TaskFlowError::Validation(_)));
}

#[test]
fn absolute_artifact_path_is_rejected() {
    let mut rt = TaskFlowRuntime::new();
    rt.create_task(
        "t.w",
        "Title",
        "orchestrator",
        "normal",
        serde_json::json!({}),
        Vec::new(),
    )
    .unwrap();
    rt.claim_task("t.w", "alpha").unwrap();
    let err = rt
        .complete_task(
            "t.w",
            "alpha",
            ResultStatus::Ok,
            "done",
            vec!["/etc/leak.txt".into()],
        )
        .expect_err("must reject absolute artifact");
    assert!(matches!(err, TaskFlowError::Validation(_)));
}
