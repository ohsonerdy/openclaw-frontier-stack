//! Happy-path FSM transitions: queued -> claimed -> waiting -> claimed -> done.

use openclaw_taskflow::{ResultStatus, TaskFlowRuntime, TaskState};

fn build_runtime_with_task() -> (TaskFlowRuntime, String) {
    let mut rt = TaskFlowRuntime::new();
    let event = rt
        .create_task(
            "task.happy",
            "Verify happy path",
            "orchestrator",
            "normal",
            serde_json::json!({}),
            Vec::new(),
        )
        .expect("create_task");
    let task_id = event.body.get("taskId").unwrap().as_str().unwrap().to_string();
    (rt, task_id)
}

#[test]
fn create_then_claim_then_complete_ok_lands_in_done() {
    let (mut rt, task_id) = build_runtime_with_task();
    rt.claim_task(&task_id, "alpha").unwrap();
    rt.complete_task(&task_id, "alpha", ResultStatus::Ok, "all good", Vec::new())
        .unwrap();
    let snap = rt.snapshot();
    let task = snap.tasks.get(&task_id).expect("task present");
    assert_eq!(task.state, TaskState::Done);
    assert_eq!(task.agent.as_deref(), Some("alpha"));
}

#[test]
fn wait_then_resume_returns_to_claimed_when_reclaimed() {
    let (mut rt, task_id) = build_runtime_with_task();
    rt.claim_task(&task_id, "alpha").unwrap();
    rt.wait_task(&task_id, "alpha", "awaiting upstream", "")
        .unwrap();
    let snap = rt.snapshot();
    assert_eq!(snap.tasks.get(&task_id).unwrap().state, TaskState::Waiting);

    rt.claim_task(&task_id, "alpha").unwrap();
    let snap = rt.snapshot();
    assert_eq!(snap.tasks.get(&task_id).unwrap().state, TaskState::Claimed);
}

#[test]
fn block_records_reason_and_state() {
    let (mut rt, task_id) = build_runtime_with_task();
    rt.claim_task(&task_id, "alpha").unwrap();
    rt.block_task(&task_id, "alpha", "needs operator input")
        .unwrap();
    let snap = rt.snapshot();
    let task = snap.tasks.get(&task_id).unwrap();
    assert_eq!(task.state, TaskState::Blocked);
    assert_eq!(task.reason.as_deref(), Some("needs operator input"));
}

#[test]
fn failed_result_lands_in_failed_state() {
    let (mut rt, task_id) = build_runtime_with_task();
    rt.claim_task(&task_id, "alpha").unwrap();
    rt.complete_task(
        &task_id,
        "alpha",
        ResultStatus::Failed,
        "oops",
        Vec::new(),
    )
    .unwrap();
    let snap = rt.snapshot();
    assert_eq!(snap.tasks.get(&task_id).unwrap().state, TaskState::Failed);
}

#[test]
fn snapshot_history_records_event_ids_in_order() {
    let (mut rt, task_id) = build_runtime_with_task();
    let claimed = rt.claim_task(&task_id, "alpha").unwrap();
    let result = rt
        .complete_task(&task_id, "alpha", ResultStatus::Ok, "ok", Vec::new())
        .unwrap();
    let snap = rt.snapshot();
    let history = &snap.tasks.get(&task_id).unwrap().history;
    assert_eq!(history.len(), 3);
    assert_eq!(history[1], claimed.id);
    assert_eq!(history[2], result.id);
}

#[test]
fn snapshot_counts_event_kinds() {
    let (mut rt, task_id) = build_runtime_with_task();
    rt.claim_task(&task_id, "alpha").unwrap();
    rt.complete_task(&task_id, "alpha", ResultStatus::Ok, "ok", Vec::new())
        .unwrap();
    let snap = rt.snapshot();
    assert_eq!(*snap.counts.get("task-created").unwrap(), 1);
    assert_eq!(*snap.counts.get("task-claimed").unwrap(), 1);
    assert_eq!(*snap.counts.get("task-result").unwrap(), 1);
}

#[test]
fn artifact_paths_validated_and_stored() {
    let (mut rt, task_id) = build_runtime_with_task();
    rt.claim_task(&task_id, "alpha").unwrap();
    rt.complete_task(
        &task_id,
        "alpha",
        ResultStatus::Ok,
        "ok",
        vec!["build/out.bin".into(), "docs/notes.md".into()],
    )
    .unwrap();
    let snap = rt.snapshot();
    let arts = snap.tasks.get(&task_id).unwrap().artifacts.clone().unwrap();
    assert_eq!(arts, vec!["build/out.bin", "docs/notes.md"]);
}
