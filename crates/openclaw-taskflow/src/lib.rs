//! OpenClaw Frontier Stack in-memory taskflow.
//!
//! Mirrors `src/taskflow/lib/taskflow.js`. A `TaskFlowRuntime` is an in-memory
//! event-sourced state machine: each public method appends one event, and
//! `snapshot()` reduces the events into a task map.
//!
//! States: `queued | claimed | waiting | done | failed | blocked`.
//! Result statuses: `ok | failed | blocked`.

#![forbid(unsafe_code)]
#![deny(missing_docs)]

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

/// Schema string baked into every event.
pub const SCHEMA: &str = "openclaw-frontier.taskflow.v1";

/// Task lifecycle states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TaskState {
    /// Created and waiting for an owner.
    #[serde(rename = "queued")]
    Queued,
    /// Claimed by an agent and in progress.
    #[serde(rename = "claimed")]
    Claimed,
    /// Paused, waiting for an external condition.
    #[serde(rename = "waiting")]
    Waiting,
    /// Successfully completed.
    #[serde(rename = "done")]
    Done,
    /// Completed with failure.
    #[serde(rename = "failed")]
    Failed,
    /// Blocked indefinitely; needs operator intervention.
    #[serde(rename = "blocked")]
    Blocked,
}

impl TaskState {
    /// Wire-format string.
    pub fn as_str(self) -> &'static str {
        match self {
            TaskState::Queued => "queued",
            TaskState::Claimed => "claimed",
            TaskState::Waiting => "waiting",
            TaskState::Done => "done",
            TaskState::Failed => "failed",
            TaskState::Blocked => "blocked",
        }
    }

    /// True if this state is terminal (no further transitions allowed).
    pub fn is_terminal(self) -> bool {
        matches!(self, TaskState::Done | TaskState::Failed)
    }
}

/// Status of a task result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ResultStatus {
    /// Success.
    #[serde(rename = "ok")]
    Ok,
    /// Failure.
    #[serde(rename = "failed")]
    Failed,
    /// Blocked by external dependency.
    #[serde(rename = "blocked")]
    Blocked,
}

impl ResultStatus {
    /// Map a result status to its corresponding task state.
    pub fn to_task_state(self) -> TaskState {
        match self {
            ResultStatus::Ok => TaskState::Done,
            ResultStatus::Failed => TaskState::Failed,
            ResultStatus::Blocked => TaskState::Blocked,
        }
    }
}

/// Errors produced by the taskflow runtime.
#[derive(Debug, Error)]
pub enum TaskFlowError {
    /// A validation rule was violated.
    #[error("validation: {0}")]
    Validation(String),

    /// The task id does not exist in this runtime.
    #[error("task does not exist: {0}")]
    NotFound(String),

    /// The task is already in a terminal state.
    #[error("task is already terminal: {task_id} (state={state:?})")]
    AlreadyTerminal {
        /// Task id.
        task_id: String,
        /// Current terminal state.
        state: TaskState,
    },
}

/// Snapshot view of a task aggregated from the event log.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskRecord {
    /// Task identifier.
    pub task_id: String,
    /// Human-readable title.
    pub title: String,
    /// Agent acting as owner (orchestrator unless overridden).
    pub owner: String,
    /// Priority label.
    pub priority: String,
    /// Free-form input payload.
    pub inputs: Value,
    /// Other task ids this one depends on.
    pub depends_on: Vec<String>,
    /// Current lifecycle state.
    pub state: TaskState,
    /// Creation timestamp.
    pub created_at: String,
    /// Updated-at timestamp (most recent event).
    pub updated_at: Option<String>,
    /// Agent that last touched the task.
    pub agent: Option<String>,
    /// Reason last reported (for wait/block events).
    pub reason: Option<String>,
    /// Summary last reported (for results).
    pub summary: Option<String>,
    /// Artifacts last reported (for results).
    pub artifacts: Option<Vec<String>>,
    /// History of event ids in order.
    pub history: Vec<String>,
}

/// One event in the durable log.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskEvent {
    /// Schema version.
    pub schema: String,
    /// Event id (`<kind>-<random-hex>`).
    pub id: String,
    /// Timestamp the event was appended.
    pub ts: String,
    /// Event kind.
    pub kind: String,
    /// Inline body fields.
    #[serde(flatten)]
    pub body: serde_json::Map<String, Value>,
}

/// Full runtime snapshot returned by [`TaskFlowRuntime::snapshot`].
#[derive(Debug, Clone, Serialize)]
pub struct Snapshot {
    /// Schema version.
    pub schema: String,
    /// All tasks keyed by task id.
    pub tasks: HashMap<String, TaskRecord>,
    /// Event-kind counts.
    pub counts: HashMap<String, usize>,
    /// Full event log in order.
    pub events: Vec<TaskEvent>,
}

/// In-memory task FSM. Cheap to construct; clone for cheap snapshots of the
/// event log.
#[derive(Debug, Default)]
pub struct TaskFlowRuntime {
    events: Vec<TaskEvent>,
}

impl TaskFlowRuntime {
    /// Build a fresh runtime with no events.
    pub fn new() -> Self {
        TaskFlowRuntime { events: Vec::new() }
    }

    /// Borrow the event log.
    pub fn events(&self) -> &[TaskEvent] {
        &self.events
    }

    fn append(&mut self, kind: &str, body: serde_json::Map<String, Value>) -> TaskEvent {
        let event = TaskEvent {
            schema: SCHEMA.to_string(),
            id: format!("{}-{}", kind, random_hex(16)),
            ts: iso_now_utc(),
            kind: kind.to_string(),
            body,
        };
        self.events.push(event.clone());
        event
    }

    /// Create a new task in the `queued` state.
    pub fn create_task(
        &mut self,
        task_id: &str,
        title: &str,
        owner: &str,
        priority: &str,
        inputs: Value,
        depends_on: Vec<String>,
    ) -> Result<TaskEvent, TaskFlowError> {
        let task_id = validate_id(task_id, "taskId")?;
        let title = require_string(title, "title", 200)?;
        let owner = validate_agent(owner, "owner")?;
        let priority = require_string(priority, "priority", 32)?;
        if !inputs.is_object() {
            return Err(TaskFlowError::Validation("inputs must be an object".into()));
        }
        let mut clean_deps = Vec::with_capacity(depends_on.len());
        for d in &depends_on {
            clean_deps.push(validate_id(d, "dependsOn")?);
        }

        let mut body = serde_json::Map::new();
        body.insert("taskId".into(), Value::String(task_id));
        body.insert("title".into(), Value::String(title));
        body.insert("owner".into(), Value::String(owner));
        body.insert("priority".into(), Value::String(priority));
        body.insert("inputs".into(), inputs);
        body.insert(
            "dependsOn".into(),
            Value::Array(clean_deps.into_iter().map(Value::String).collect()),
        );
        body.insert("state".into(), Value::String("queued".into()));
        Ok(self.append("task-created", body))
    }

    /// Claim a queued or waiting task. Errors if the task is already done or
    /// failed.
    pub fn claim_task(&mut self, task_id: &str, agent: &str) -> Result<TaskEvent, TaskFlowError> {
        let task_id = validate_id(task_id, "taskId")?;
        let agent = validate_agent(agent, "agent")?;

        // We need to peek at current state.
        let current = self.snapshot().tasks.get(&task_id).cloned();
        let task = current.ok_or_else(|| TaskFlowError::NotFound(task_id.clone()))?;
        if task.state.is_terminal() {
            return Err(TaskFlowError::AlreadyTerminal {
                task_id,
                state: task.state,
            });
        }

        let mut body = serde_json::Map::new();
        body.insert("taskId".into(), Value::String(task_id));
        body.insert("agent".into(), Value::String(agent));
        body.insert("state".into(), Value::String("claimed".into()));
        Ok(self.append("task-claimed", body))
    }

    /// Move a task to `waiting`.
    pub fn wait_task(
        &mut self,
        task_id: &str,
        agent: &str,
        reason: &str,
        wake_after: &str,
    ) -> Result<TaskEvent, TaskFlowError> {
        let task_id = validate_id(task_id, "taskId")?;
        let agent = validate_agent(agent, "agent")?;
        let reason = require_string(reason, "reason", 500)?;
        let wake_after = if wake_after.is_empty() {
            String::new()
        } else {
            require_string(wake_after, "wakeAfter", 128)?
        };

        let mut body = serde_json::Map::new();
        body.insert("taskId".into(), Value::String(task_id));
        body.insert("agent".into(), Value::String(agent));
        body.insert("reason".into(), Value::String(reason));
        body.insert("wakeAfter".into(), Value::String(wake_after));
        body.insert("state".into(), Value::String("waiting".into()));
        Ok(self.append("task-waiting", body))
    }

    /// Move a task to `blocked`.
    pub fn block_task(
        &mut self,
        task_id: &str,
        agent: &str,
        reason: &str,
    ) -> Result<TaskEvent, TaskFlowError> {
        let task_id = validate_id(task_id, "taskId")?;
        let agent = validate_agent(agent, "agent")?;
        let reason = require_string(reason, "reason", 500)?;
        let mut body = serde_json::Map::new();
        body.insert("taskId".into(), Value::String(task_id));
        body.insert("agent".into(), Value::String(agent));
        body.insert("reason".into(), Value::String(reason));
        body.insert("state".into(), Value::String("blocked".into()));
        Ok(self.append("task-blocked", body))
    }

    /// Complete a task with a result status. Status `ok` moves the task to
    /// `done`, otherwise it moves to the equivalent of the status.
    pub fn complete_task(
        &mut self,
        task_id: &str,
        agent: &str,
        status: ResultStatus,
        summary: &str,
        artifacts: Vec<String>,
    ) -> Result<TaskEvent, TaskFlowError> {
        let task_id = validate_id(task_id, "taskId")?;
        let agent = validate_agent(agent, "agent")?;
        let summary = require_string(summary, "summary", 1000)?;

        if !self.snapshot().tasks.contains_key(&task_id) {
            return Err(TaskFlowError::NotFound(task_id));
        }

        let mut clean_arts = Vec::with_capacity(artifacts.len());
        for a in &artifacts {
            clean_arts.push(validate_rel_path(a, "artifact")?);
        }

        let mut body = serde_json::Map::new();
        body.insert("taskId".into(), Value::String(task_id));
        body.insert("agent".into(), Value::String(agent));
        body.insert("status".into(), Value::String(status.to_string()));
        body.insert("summary".into(), Value::String(summary));
        body.insert(
            "artifacts".into(),
            Value::Array(clean_arts.into_iter().map(Value::String).collect()),
        );
        body.insert(
            "state".into(),
            Value::String(status.to_task_state().as_str().to_string()),
        );
        Ok(self.append("task-result", body))
    }

    /// Reduce events to a snapshot.
    pub fn snapshot(&self) -> Snapshot {
        let mut tasks: HashMap<String, TaskRecord> = HashMap::new();
        for event in &self.events {
            match event.kind.as_str() {
                "task-created" => {
                    let task_id = body_str(&event.body, "taskId").unwrap_or_default();
                    if task_id.is_empty() {
                        continue;
                    }
                    let depends_on: Vec<String> = event
                        .body
                        .get("dependsOn")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                .collect()
                        })
                        .unwrap_or_default();
                    tasks.insert(
                        task_id.clone(),
                        TaskRecord {
                            task_id,
                            title: body_str(&event.body, "title").unwrap_or_default(),
                            owner: body_str(&event.body, "owner").unwrap_or_default(),
                            priority: body_str(&event.body, "priority").unwrap_or_default(),
                            inputs: event
                                .body
                                .get("inputs")
                                .cloned()
                                .unwrap_or_else(|| Value::Object(serde_json::Map::new())),
                            depends_on,
                            state: TaskState::Queued,
                            created_at: event.ts.clone(),
                            updated_at: None,
                            agent: None,
                            reason: None,
                            summary: None,
                            artifacts: None,
                            history: vec![event.id.clone()],
                        },
                    );
                }
                _ => {
                    let task_id = match body_str(&event.body, "taskId") {
                        Some(s) if !s.is_empty() => s,
                        _ => continue,
                    };
                    if let Some(task) = tasks.get_mut(&task_id) {
                        task.history.push(event.id.clone());
                        if let Some(agent) = body_str(&event.body, "agent") {
                            task.agent = Some(agent);
                        }
                        if let Some(state) = body_str(&event.body, "state") {
                            if let Some(new_state) = parse_state(&state) {
                                task.state = new_state;
                            }
                        }
                        if let Some(reason) = body_str(&event.body, "reason") {
                            if !reason.is_empty() {
                                task.reason = Some(reason);
                            }
                        }
                        if let Some(summary) = body_str(&event.body, "summary") {
                            if !summary.is_empty() {
                                task.summary = Some(summary);
                            }
                        }
                        if let Some(arts) = event.body.get("artifacts").and_then(|v| v.as_array()) {
                            task.artifacts = Some(
                                arts.iter()
                                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                    .collect(),
                            );
                        }
                        task.updated_at = Some(event.ts.clone());
                    }
                }
            }
        }

        let mut counts = HashMap::new();
        for event in &self.events {
            *counts.entry(event.kind.clone()).or_insert(0) += 1;
        }
        Snapshot {
            schema: SCHEMA.to_string(),
            tasks,
            counts,
            events: self.events.clone(),
        }
    }
}

fn body_str(map: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    map.get(key).and_then(|v| v.as_str().map(|s| s.to_string()))
}

fn parse_state(s: &str) -> Option<TaskState> {
    match s {
        "queued" => Some(TaskState::Queued),
        "claimed" => Some(TaskState::Claimed),
        "waiting" => Some(TaskState::Waiting),
        "done" => Some(TaskState::Done),
        "failed" => Some(TaskState::Failed),
        "blocked" => Some(TaskState::Blocked),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

fn require_string(value: &str, label: &str, max: usize) -> Result<String, TaskFlowError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(TaskFlowError::Validation(format!(
            "{label} must not be empty"
        )));
    }
    if trimmed.len() > max {
        return Err(TaskFlowError::Validation(format!(
            "{label} exceeds {max} chars"
        )));
    }
    Ok(trimmed.to_string())
}

fn validate_id(value: &str, label: &str) -> Result<String, TaskFlowError> {
    let id = require_string(value, label, 128)?;
    let mut chars = id.chars();
    let first = chars.next().unwrap();
    if !first.is_ascii_alphanumeric() {
        return Err(TaskFlowError::Validation(format!(
            "{label} must be a simple id"
        )));
    }
    for c in chars {
        if !(c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-')) {
            return Err(TaskFlowError::Validation(format!(
                "{label} must be a simple id"
            )));
        }
    }
    Ok(id)
}

fn validate_agent(value: &str, label: &str) -> Result<String, TaskFlowError> {
    let id = require_string(value, label, 64)?;
    let mut chars = id.chars();
    let first = chars.next().unwrap();
    if !first.is_ascii_alphabetic() {
        return Err(TaskFlowError::Validation(format!(
            "{label} must be a simple agent id"
        )));
    }
    for c in chars {
        if !(c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            return Err(TaskFlowError::Validation(format!(
                "{label} must be a simple agent id"
            )));
        }
    }
    Ok(id)
}

/// Validate a relative artifact path. Backslashes are converted to forward
/// slashes, then the path must not be absolute, URL-shaped, tilde-rooted, or
/// contain null bytes, empty segments, dot, dotdot, or secret-like keywords.
pub fn validate_rel_path(value: &str, label: &str) -> Result<String, TaskFlowError> {
    let raw = require_string(value, label, 512)?;
    let forward: String = raw.chars().map(|c| if c == '\\' { '/' } else { c }).collect();
    if is_url_like(&forward) || forward.starts_with('/') || forward.starts_with('~') || forward.contains('\0') {
        return Err(TaskFlowError::Validation(format!(
            "{label} must be a relative package path"
        )));
    }
    for part in forward.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err(TaskFlowError::Validation(format!(
                "{label} has unsafe path segment"
            )));
        }
    }
    if has_secret_keyword(&forward) {
        return Err(TaskFlowError::Validation(format!(
            "{label} contains secret-like segment"
        )));
    }
    Ok(forward)
}

fn is_url_like(s: &str) -> bool {
    // [A-Za-z][A-Za-z0-9+.-]*:  (taskflow.js uses `:` without `//`)
    let mut chars = s.chars();
    let first = chars.next();
    if !matches!(first, Some(c) if c.is_ascii_alphabetic()) {
        return false;
    }
    let mut end = 1;
    for c in chars {
        if c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-') {
            end += c.len_utf8();
        } else {
            break;
        }
    }
    s.as_bytes().get(end) == Some(&b':')
}

fn has_secret_keyword(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    let keywords = [
        "secret",
        "token",
        "credential",
        "password",
        "private",
        "oauth",
        "session",
        "vault",
        "key",
    ];
    let bytes = lower.as_bytes();
    for kw in keywords {
        let kw_bytes = kw.as_bytes();
        let n = bytes.len();
        let m = kw_bytes.len();
        if m == 0 || n < m {
            continue;
        }
        let is_sep = |c: u8| matches!(c, b'/' | b'_' | b'.' | b'-');
        let mut i = 0;
        while i + m <= n {
            if &bytes[i..i + m] == kw_bytes {
                let left_ok = i == 0 || is_sep(bytes[i - 1]);
                let right_ok = i + m == n || is_sep(bytes[i + m]);
                if left_ok && right_ok {
                    return true;
                }
            }
            i += 1;
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

impl std::fmt::Display for ResultStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            ResultStatus::Ok => "ok",
            ResultStatus::Failed => "failed",
            ResultStatus::Blocked => "blocked",
        })
    }
}

fn random_hex(n_bytes: usize) -> String {
    let mut buf = vec![0u8; n_bytes];
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0xdead_beef_dead_beef);
    let pid_mix = (std::process::id() as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    let mut state = nanos ^ pid_mix ^ 0x1234_5678_9ABC_DEF0;
    if state == 0 {
        state = 0xa5a5_a5a5_a5a5_a5a5;
    }
    for byte in buf.iter_mut() {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        *byte = state as u8;
    }
    let mut s = String::with_capacity(n_bytes * 2);
    for b in buf {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

fn iso_now_utc() -> String {
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    let millis = dur.subsec_millis();
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

fn days_to_ymd(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    (year as i32, m as u32, d as u32)
}
