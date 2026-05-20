//! OpenClaw Frontier Stack blackboard ledger.
//!
//! Mirrors `src/blackboard/lib/ledger.js`. The blackboard is an append-only
//! JSONL file where agents publish coordination records: task claims, path
//! claims, facts, decisions, and results. Mutual exclusion is provided by an
//! atomic `mkdir` lock against the same lock-path the Node implementation
//! uses, so Rust and Node processes can share a single blackboard file.
//!
//! ## On-disk format
//!
//! One JSON record per line, `\n` terminator, no trailing whitespace. The
//! file ends with a final `\n` after the last record (and nothing more) so
//! every line — including the last — is a complete record.
//!
//! ## Locking
//!
//! Before any append, the implementation creates `<ledger>.lock/` with
//! `mkdir`. `mkdir` is atomic in POSIX and on NTFS; both Node's
//! `fs.mkdirSync` and Rust's `std::fs::create_dir` rely on this. If the
//! directory already exists, the call returns `AlreadyExists` and we retry
//! after a brief randomized backoff (5-19 ms). After `lock_timeout_ms`
//! elapsed without success, we return [`BlackboardError::LockTimeout`].
//! Stale locks older than `stale_lock_ms` are reaped.

#![forbid(unsafe_code)]
#![deny(missing_docs)]

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

/// Schema string used on every record.
pub const SCHEMA: &str = "openclaw-frontier.blackboard-ledger.v1";

const DEFAULT_LOCK_TIMEOUT_MS: u64 = 10_000;
const DEFAULT_STALE_LOCK_MS: u64 = 30_000;

/// Valid record kinds the ledger will accept.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum RecordKind {
    /// Agent claims a task (work item).
    #[serde(rename = "task-claim")]
    TaskClaim,
    /// Agent claims a relative path for exclusive write access.
    #[serde(rename = "path-claim")]
    PathClaim,
    /// Agent releases a previously claimed path.
    #[serde(rename = "path-release")]
    PathRelease,
    /// Agent records a fact (assertion).
    #[serde(rename = "fact")]
    Fact,
    /// Agent records a decision.
    #[serde(rename = "decision")]
    Decision,
    /// Agent records the result of a task.
    #[serde(rename = "result")]
    Result,
}

impl RecordKind {
    /// Wire string for this kind.
    pub fn as_str(self) -> &'static str {
        match self {
            RecordKind::TaskClaim => "task-claim",
            RecordKind::PathClaim => "path-claim",
            RecordKind::PathRelease => "path-release",
            RecordKind::Fact => "fact",
            RecordKind::Decision => "decision",
            RecordKind::Result => "result",
        }
    }
}

/// Errors produced by the blackboard.
#[derive(Debug, Error)]
pub enum BlackboardError {
    /// A validation rule was violated.
    #[error("validation: {0}")]
    Validation(String),

    /// A path is already claimed by another agent/task pair.
    #[error("path already claimed: {path} (owned by {agent} for task {task_id})")]
    PathClaimed {
        /// Normalized relative path that is already claimed.
        path: String,
        /// Agent id that holds the claim.
        agent: String,
        /// Task id the claim is associated with.
        task_id: String,
    },

    /// The lock could not be acquired within the configured timeout.
    #[error("ledger lock timeout after {timeout_ms} ms")]
    LockTimeout {
        /// Configured timeout in milliseconds.
        timeout_ms: u64,
    },

    /// I/O error.
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    /// JSON parse/serialization error.
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
}

/// A single ledger record after construction.
///
/// All records share a common header (`schema`, `id`, `ts`, `kind`). Kind-
/// specific fields live in [`Record::extra`] for forward compatibility with
/// new record shapes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Record {
    /// Schema version string ([`SCHEMA`]).
    pub schema: String,
    /// Unique id of this record (`<kind>-<random-hex>`).
    pub id: String,
    /// ISO-8601 UTC timestamp when the record was appended.
    pub ts: String,
    /// Record kind.
    pub kind: RecordKind,
    /// Kind-specific fields as a flat JSON object.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

impl Record {
    /// Get an extra field as a string slice.
    pub fn get_str(&self, key: &str) -> Option<&str> {
        self.extra.get(key).and_then(|v| v.as_str())
    }

    /// Get an extra field as a bool.
    pub fn get_bool(&self, key: &str) -> Option<bool> {
        self.extra.get(key).and_then(|v| v.as_bool())
    }
}

/// Snapshot of the ledger reduced from its event log.
#[derive(Debug, Clone, Default)]
pub struct Snapshot {
    /// Schema version string.
    pub schema: String,
    /// Tasks keyed by task id.
    pub tasks: HashMap<String, TaskState>,
    /// Currently-held path claims, keyed by normalized path.
    pub path_claims: HashMap<String, PathClaimState>,
    /// All `fact` records in insertion order.
    pub facts: Vec<Record>,
    /// All `decision` records in insertion order.
    pub decisions: Vec<Record>,
    /// All `result` records in insertion order.
    pub results: Vec<Record>,
    /// Count of records per kind.
    pub counts: HashMap<RecordKind, usize>,
}

/// Reduced task state inside a snapshot.
#[derive(Debug, Clone)]
pub struct TaskState {
    /// Agent that claimed this task.
    pub agent: String,
    /// Human-readable summary at claim time.
    pub summary: String,
    /// Lifecycle status: `claimed | done | failed`.
    pub status: String,
    /// Claim timestamp.
    pub claimed_at: String,
    /// Result timestamp, if a result has been recorded.
    pub result_at: Option<String>,
}

/// Reduced path-claim state inside a snapshot.
#[derive(Debug, Clone)]
pub struct PathClaimState {
    /// Agent that holds the claim.
    pub agent: String,
    /// Task id the claim is associated with.
    pub task_id: String,
    /// Claim mode (`read | write`).
    pub mode: String,
    /// Operator-provided reason.
    pub reason: String,
    /// Claim timestamp.
    pub claimed_at: String,
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const SECRETISH_SEGMENT_KEYWORDS: &[&str] = &[
    "secret",
    "secrets",
    "token",
    "tokens",
    "credential",
    "credentials",
    "password",
    "passwd",
    "private",
    "apikey",
    "auth",
    "oauth",
    "cookie",
    "session",
    "vault",
    "key",
    "keys",
];

fn require_string(value: &str, field: &str, max: usize) -> Result<String, BlackboardError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(BlackboardError::Validation(format!(
            "{field} must not be empty"
        )));
    }
    if trimmed.len() > max {
        return Err(BlackboardError::Validation(format!(
            "{field} exceeds {max} characters"
        )));
    }
    Ok(trimmed.to_string())
}

fn validate_agent_id(value: &str) -> Result<String, BlackboardError> {
    let agent = require_string(value, "agent", 64)?;
    let mut chars = agent.chars();
    let first = chars.next().unwrap();
    if !first.is_ascii_alphabetic() {
        return Err(BlackboardError::Validation(
            "agent must be a simple agent id".into(),
        ));
    }
    for c in chars {
        if !(c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            return Err(BlackboardError::Validation(
                "agent must be a simple agent id".into(),
            ));
        }
    }
    Ok(agent)
}

fn validate_task_id(value: &str) -> Result<String, BlackboardError> {
    let id = require_string(value, "taskId", 128)?;
    let mut chars = id.chars();
    let first = chars.next().unwrap();
    if !first.is_ascii_alphanumeric() {
        return Err(BlackboardError::Validation(
            "taskId must be a simple task id".into(),
        ));
    }
    for c in chars {
        if !(c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-')) {
            return Err(BlackboardError::Validation(
                "taskId must be a simple task id".into(),
            ));
        }
    }
    Ok(id)
}

/// Normalize a relative path the same way the JS implementation does.
/// Rejects absolute paths, tilde-paths, URLs, control bytes, empty segments,
/// dot/dotdot segments, and known secret-like segment names.
pub fn normalize_record_path(raw: &str) -> Result<String, BlackboardError> {
    let raw = require_string(raw, "path", 512)?;
    if raw.contains('\0') || raw.contains('\r') || raw.contains('\n') {
        return Err(BlackboardError::Validation(
            "path contains invalid control characters".into(),
        ));
    }
    if is_url_like(&raw) {
        return Err(BlackboardError::Validation("path must not be a URL".into()));
    }
    if is_absolute(&raw) || raw.starts_with('~') || raw.starts_with("~/") || raw.starts_with("~\\") {
        return Err(BlackboardError::Validation("path must be relative".into()));
    }

    // Convert backslashes to forward slashes and split.
    let forward: String = raw.chars().map(|c| if c == '\\' { '/' } else { c }).collect();
    let parts: Vec<&str> = forward.split('/').collect();
    for part in &parts {
        if part.is_empty() || *part == "." {
            return Err(BlackboardError::Validation(
                "path must not contain empty or dot segments".into(),
            ));
        }
    }
    if parts.iter().any(|p| *p == "..") {
        return Err(BlackboardError::Validation(
            "path must not contain parent-directory segments".into(),
        ));
    }
    for part in &parts {
        if looks_like_secret(part) {
            return Err(BlackboardError::Validation(
                "path contains a secret-like segment name".into(),
            ));
        }
    }

    // posix.normalize() — since we already rejected dot and dotdot, this
    // is effectively a no-op except for collapsing trailing slashes.
    let normalized = parts.join("/");
    if normalized.is_empty() || normalized == "." {
        return Err(BlackboardError::Validation(
            "path must stay inside the workspace-relative namespace".into(),
        ));
    }
    Ok(normalized)
}

fn is_url_like(s: &str) -> bool {
    // [A-Za-z][A-Za-z0-9+.-]*:// matches a URL scheme. We only need to peek
    // the prefix up to `://`.
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
    s.get(end..end + 3) == Some("://")
}

fn is_absolute(s: &str) -> bool {
    // POSIX:  starts with `/`
    if s.starts_with('/') {
        return true;
    }
    // Windows: `<letter>:[/\\]`
    let bytes = s.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\')
    {
        return true;
    }
    false
}

fn looks_like_secret(segment: &str) -> bool {
    let lower = segment.to_ascii_lowercase();
    // .env, .env.local etc.
    if lower == ".env" || lower.starts_with(".env.") {
        return true;
    }
    // SSH key names.
    if matches!(lower.as_str(), "id_rsa" | "id_dsa" | "id_ecdsa" | "id_ed25519") {
        return true;
    }
    // Sensitive extensions.
    for ext in ["pem", "key", "p12", "pfx", "kdbx"] {
        if lower.ends_with(&format!(".{ext}")) {
            return true;
        }
    }
    // Keyword embedded with separator.
    for kw in SECRETISH_SEGMENT_KEYWORDS {
        if contains_word_keyword(&lower, kw) {
            return true;
        }
    }
    false
}

fn contains_word_keyword(s: &str, kw: &str) -> bool {
    // Match keyword when surrounded by start-of-string, separator (`-`, `_`,
    // `.`), or end-of-string. Mirrors the JS `(^|[-_.])kw([-_.]|$)` regex.
    let bytes = s.as_bytes();
    let kw_bytes = kw.as_bytes();
    let n = bytes.len();
    let m = kw_bytes.len();
    if m == 0 || n < m {
        return false;
    }
    let is_sep = |c: u8| matches!(c, b'-' | b'_' | b'.');
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
    false
}

/// Run the production-safety scan against a JSON-serialized record. Returns
/// `Err(Validation)` if a pattern matches.
pub fn validate_public_safe_record(record: &Value) -> Result<(), BlackboardError> {
    let text = serde_json::to_string(record)?;
    scan_for_secrets(&text)
}

fn scan_for_secrets(text: &str) -> Result<(), BlackboardError> {
    if text.contains("-----BEGIN ") && text.contains("PRIVATE KEY-----") {
        return Err(BlackboardError::Validation(
            "record failed production-safety scan: private-key-block".into(),
        ));
    }
    if has_home_path(text) {
        return Err(BlackboardError::Validation(
            "record failed production-safety scan: home-path".into(),
        ));
    }
    if has_api_token(text) {
        return Err(BlackboardError::Validation(
            "record failed production-safety scan: api-key-shape".into(),
        ));
    }
    if has_rfc1918_or_cgnat(text) {
        return Err(BlackboardError::Validation(
            "record failed production-safety scan: ipv4-address".into(),
        ));
    }
    Ok(())
}

fn has_home_path(text: &str) -> bool {
    if let Some(pos) = text.find("/Users/") {
        let rest = &text[pos + "/Users/".len()..];
        if rest.chars().next().is_some_and(is_user_seg_char) {
            return true;
        }
    }
    let bytes = text.as_bytes();
    for i in 0..bytes.len().saturating_sub(8) {
        if !bytes[i].is_ascii_alphabetic() {
            continue;
        }
        if bytes[i + 1] == b':' && bytes[i + 2] == b'\\' {
            let tail = &text[i + 3..];
            if let Some(rest) = tail.strip_prefix("Users\\") {
                if rest.chars().next().is_some_and(is_user_seg_char) {
                    return true;
                }
            }
        }
    }
    false
}

fn is_user_seg_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')
}

fn has_api_token(text: &str) -> bool {
    for prefix in ["sk-", "ghp_", "github_pat_", "xoxa-", "xoxb-", "xoxp-", "xoxo-", "xoxr-", "xoxs-"] {
        let bytes = text.as_bytes();
        let mut start = 0;
        while let Some(rel) = text[start..].find(prefix) {
            let pos = start + rel;
            // Require a word boundary before the prefix.
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

fn has_rfc1918_or_cgnat(text: &str) -> bool {
    if try_ipv4(text, "10.", 3) {
        return true;
    }
    if try_ipv4(text, "192.168.", 2) {
        return true;
    }
    for second in 16..=31 {
        if try_ipv4(text, &format!("172.{second}."), 2) {
            return true;
        }
    }
    for second in 64..=127 {
        if try_ipv4(text, &format!("100.{second}."), 2) {
            return true;
        }
    }
    false
}

fn try_ipv4(text: &str, prefix: &str, need_more_octets: usize) -> bool {
    if let Some(pos) = text.find(prefix) {
        // Boundary: digit immediately before the prefix means we matched in
        // the middle of a longer number (e.g. "210.0.0.1" should not match
        // "10."). Require either start-of-string or a non-digit-non-dot
        // character before the prefix.
        if pos > 0 {
            let prev = text.as_bytes()[pos - 1];
            if prev.is_ascii_digit() {
                return false;
            }
        }
        let tail = &text[pos + prefix.len()..];
        let mut iter = tail.split('.');
        let mut count = 0;
        for piece in iter.by_ref().take(need_more_octets) {
            let digit_run: String = piece.chars().take(3).take_while(|c| c.is_ascii_digit()).collect();
            if digit_run.is_empty() {
                return false;
            }
            count += 1;
        }
        return count == need_more_octets;
    }
    false
}

// ---------------------------------------------------------------------------
// JSONL parsing
// ---------------------------------------------------------------------------

/// Parse a UTF-8 string of JSONL into records. Each non-empty line must be a
/// JSON object that matches the [`Record`] shape.
///
/// `source` is used for error messages only.
pub fn parse_jsonl(text: &str, source: &str) -> Result<Vec<Record>, BlackboardError> {
    let mut out = Vec::new();
    for (idx, line) in text.split('\n').enumerate() {
        // Trim trailing `\r` from CRLF lines.
        let trimmed = line.trim_end_matches('\r').trim();
        if trimmed.is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(trimmed).map_err(|e| {
            BlackboardError::Validation(format!(
                "invalid JSONL at {source}:{}: {e}",
                idx + 1
            ))
        })?;
        let record: Record = serde_json::from_value(value).map_err(|e| {
            BlackboardError::Validation(format!(
                "invalid record at {source}:{}: {e}",
                idx + 1
            ))
        })?;
        out.push(record);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/// Append-only JSONL ledger with mkdir-based mutual exclusion.
pub struct Ledger {
    ledger_path: PathBuf,
    lock_path: PathBuf,
    lock_timeout_ms: u64,
    stale_lock_ms: u64,
}

/// Options for configuring a [`Ledger`].
#[derive(Debug, Clone)]
pub struct LedgerOptions {
    /// Path to the JSONL file.
    pub ledger_path: PathBuf,
    /// Path to the lock directory. Default: `<ledger_path>.lock`.
    pub lock_path: Option<PathBuf>,
    /// Maximum time to wait for the lock, in milliseconds.
    pub lock_timeout_ms: u64,
    /// Locks older than this are considered stale and forcibly removed.
    pub stale_lock_ms: u64,
}

impl LedgerOptions {
    /// Build options pointing at `ledger_path` with default timeouts.
    pub fn new(ledger_path: impl Into<PathBuf>) -> Self {
        LedgerOptions {
            ledger_path: ledger_path.into(),
            lock_path: None,
            lock_timeout_ms: DEFAULT_LOCK_TIMEOUT_MS,
            stale_lock_ms: DEFAULT_STALE_LOCK_MS,
        }
    }
}

impl Ledger {
    /// Build a new ledger.
    pub fn open(options: LedgerOptions) -> Self {
        let ledger_path = options.ledger_path;
        let lock_path = options
            .lock_path
            .unwrap_or_else(|| {
                let mut p = ledger_path.clone().into_os_string();
                p.push(".lock");
                PathBuf::from(p)
            });
        Ledger {
            ledger_path,
            lock_path,
            lock_timeout_ms: options.lock_timeout_ms,
            stale_lock_ms: options.stale_lock_ms,
        }
    }

    /// Path to the JSONL file backing this ledger.
    pub fn ledger_path(&self) -> &Path {
        &self.ledger_path
    }

    /// Append a pre-built record under the lock.
    pub fn append(&self, record: Record) -> Result<Record, BlackboardError> {
        self.with_lock(|| self.append_unlocked(record))
    }

    fn ensure_dir(&self) -> Result<(), BlackboardError> {
        if let Some(parent) = self.ledger_path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)?;
            }
        }
        Ok(())
    }

    fn append_unlocked(&self, record: Record) -> Result<Record, BlackboardError> {
        let value = serde_json::to_value(&record)?;
        validate_public_safe_record(&value)?;
        self.ensure_dir()?;
        let line = format!("{}\n", serde_json::to_string(&record)?);
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.ledger_path)?;
        file.write_all(line.as_bytes())?;
        file.sync_data()?;
        Ok(record)
    }

    /// Read all records currently in the ledger. Returns an empty vector if
    /// the file does not exist.
    pub fn read_records(&self) -> Result<Vec<Record>, BlackboardError> {
        if !self.ledger_path.exists() {
            return Ok(Vec::new());
        }
        let text = fs::read_to_string(&self.ledger_path)?;
        let source = self.ledger_path.display().to_string();
        let records = parse_jsonl(&text, &source)?;
        for r in &records {
            validate_public_safe_record(&serde_json::to_value(r)?)?;
        }
        Ok(records)
    }

    /// Reduce all records into a [`Snapshot`].
    pub fn snapshot(&self) -> Result<Snapshot, BlackboardError> {
        let records = self.read_records()?;
        reduce_to_snapshot(&records)
    }

    /// Claim a task. Always appends; collision detection for tasks lives
    /// upstream (snapshots show the most recent claim).
    pub fn claim_task(
        &self,
        agent: &str,
        task_id: &str,
        summary: &str,
    ) -> Result<Record, BlackboardError> {
        let agent = validate_agent_id(agent)?;
        let task_id = validate_task_id(task_id)?;
        let summary = require_string(summary, "summary", 500)?;
        let mut extra = serde_json::Map::new();
        extra.insert("agent".into(), Value::String(agent));
        extra.insert("taskId".into(), Value::String(task_id));
        extra.insert("summary".into(), Value::String(summary));
        extra.insert("status".into(), Value::String("claimed".into()));
        self.append(build_record(RecordKind::TaskClaim, extra))
    }

    /// Claim a relative path for exclusive write. Returns
    /// [`BlackboardError::PathClaimed`] if another agent/task already holds
    /// the path.
    pub fn claim_path(
        &self,
        agent: &str,
        task_id: &str,
        path: &str,
        mode: &str,
        reason: &str,
    ) -> Result<Record, BlackboardError> {
        self.with_lock(|| {
            let normalized = normalize_record_path(path)?;
            let snap = reduce_to_snapshot(&self.read_records()?)?;
            if let Some(existing) = snap.path_claims.get(&normalized) {
                if existing.agent != agent || existing.task_id != task_id {
                    return Err(BlackboardError::PathClaimed {
                        path: normalized,
                        agent: existing.agent.clone(),
                        task_id: existing.task_id.clone(),
                    });
                }
            }
            let agent = validate_agent_id(agent)?;
            let task_id = validate_task_id(task_id)?;
            let mut extra = serde_json::Map::new();
            extra.insert("agent".into(), Value::String(agent));
            extra.insert("taskId".into(), Value::String(task_id));
            extra.insert("path".into(), Value::String(normalized));
            extra.insert(
                "mode".into(),
                Value::String(require_string(mode, "mode", 32)?),
            );
            let reason = if reason.is_empty() {
                String::new()
            } else {
                require_string(reason, "reason", 500)?
            };
            extra.insert("reason".into(), Value::String(reason));
            self.append_unlocked(build_record(RecordKind::PathClaim, extra))
        })
    }

    /// Release a previously-claimed path.
    pub fn release_path(
        &self,
        agent: &str,
        task_id: &str,
        path: &str,
        reason: &str,
    ) -> Result<Record, BlackboardError> {
        let agent = validate_agent_id(agent)?;
        let task_id = validate_task_id(task_id)?;
        let path = normalize_record_path(path)?;
        let reason = if reason.is_empty() {
            String::new()
        } else {
            require_string(reason, "reason", 500)?
        };
        let mut extra = serde_json::Map::new();
        extra.insert("agent".into(), Value::String(agent));
        extra.insert("taskId".into(), Value::String(task_id));
        extra.insert("path".into(), Value::String(path));
        extra.insert("reason".into(), Value::String(reason));
        self.append(build_record(RecordKind::PathRelease, extra))
    }

    /// Record a fact.
    pub fn record_fact(
        &self,
        agent: &str,
        subject: &str,
        value: Value,
        evidence: Vec<String>,
    ) -> Result<Record, BlackboardError> {
        let agent = validate_agent_id(agent)?;
        let subject = require_string(subject, "subject", 200)?;
        let mut extra = serde_json::Map::new();
        extra.insert("agent".into(), Value::String(agent));
        extra.insert("subject".into(), Value::String(subject));
        extra.insert("value".into(), value);
        extra.insert(
            "evidence".into(),
            Value::Array(evidence.into_iter().map(Value::String).collect()),
        );
        self.append(build_record(RecordKind::Fact, extra))
    }

    /// Record a decision.
    pub fn record_decision(
        &self,
        agent: &str,
        task_id: Option<&str>,
        decision: &str,
        status: &str,
        rationale: &str,
    ) -> Result<Record, BlackboardError> {
        let agent = validate_agent_id(agent)?;
        let decision = require_string(decision, "decision", 200)?;
        let status = require_string(status, "status", 64)?;
        let mut extra = serde_json::Map::new();
        extra.insert("agent".into(), Value::String(agent));
        extra.insert("decision".into(), Value::String(decision));
        extra.insert("status".into(), Value::String(status));
        let rationale = if rationale.is_empty() {
            String::new()
        } else {
            require_string(rationale, "rationale", 1000)?
        };
        extra.insert("rationale".into(), Value::String(rationale));
        if let Some(tid) = task_id {
            extra.insert("taskId".into(), Value::String(validate_task_id(tid)?));
        }
        self.append(build_record(RecordKind::Decision, extra))
    }

    /// Record a task result.
    pub fn record_result(
        &self,
        agent: &str,
        task_id: &str,
        ok: bool,
        summary: &str,
        artifacts: Vec<String>,
    ) -> Result<Record, BlackboardError> {
        let agent = validate_agent_id(agent)?;
        let task_id = validate_task_id(task_id)?;
        let summary = require_string(summary, "summary", 1000)?;
        let mut normalized = Vec::with_capacity(artifacts.len());
        for a in artifacts {
            normalized.push(normalize_record_path(&a)?);
        }
        let mut extra = serde_json::Map::new();
        extra.insert("agent".into(), Value::String(agent));
        extra.insert("taskId".into(), Value::String(task_id));
        extra.insert("ok".into(), Value::Bool(ok));
        extra.insert("summary".into(), Value::String(summary));
        extra.insert(
            "artifacts".into(),
            Value::Array(normalized.into_iter().map(Value::String).collect()),
        );
        self.append(build_record(RecordKind::Result, extra))
    }

    fn with_lock<T, F>(&self, f: F) -> Result<T, BlackboardError>
    where
        F: FnOnce() -> Result<T, BlackboardError>,
    {
        self.ensure_dir()?;
        let started = Instant::now();
        let timeout = Duration::from_millis(self.lock_timeout_ms);
        loop {
            match fs::create_dir(&self.lock_path) {
                Ok(()) => {
                    let owner = serde_json::json!({
                        "pid": std::process::id(),
                        "acquiredAt": iso_now_utc(),
                    });
                    let owner_path = self.lock_path.join("owner.json");
                    if let Err(e) = fs::write(
                        &owner_path,
                        format!("{}\n", serde_json::to_string(&owner)?),
                    ) {
                        // If we can't even write the owner file, drop the lock.
                        let _ = fs::remove_dir_all(&self.lock_path);
                        return Err(BlackboardError::Io(e));
                    }
                    break;
                }
                Err(err)
                    if err.kind() == ErrorKind::AlreadyExists
                        || err.kind() == ErrorKind::PermissionDenied =>
                {
                    if let Ok(meta) = fs::metadata(&self.lock_path) {
                        if let Ok(mtime) = meta.modified() {
                            if let Ok(elapsed) = SystemTime::now().duration_since(mtime) {
                                if elapsed.as_millis() as u64 > self.stale_lock_ms {
                                    let _ = fs::remove_dir_all(&self.lock_path);
                                    continue;
                                }
                            }
                        }
                    }
                    if started.elapsed() > timeout {
                        return Err(BlackboardError::LockTimeout {
                            timeout_ms: self.lock_timeout_ms,
                        });
                    }
                    std::thread::sleep(Duration::from_millis(backoff_ms()));
                }
                Err(e) => return Err(BlackboardError::Io(e)),
            }
        }

        let result = f();
        let _ = fs::remove_dir_all(&self.lock_path);
        result
    }
}

fn backoff_ms() -> u64 {
    // 5..=19 ms randomized backoff, matching the JS implementation.
    // We use a tiny xorshift seeded from the clock to avoid pulling in a
    // randomness dep — quality is not security-critical here.
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let mut x = nanos.wrapping_add(0x9E37_79B9) | 1;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    5 + (x as u64 % 15)
}

fn build_record(kind: RecordKind, extra: serde_json::Map<String, Value>) -> Record {
    Record {
        schema: SCHEMA.to_string(),
        id: format!("{}-{}", kind.as_str(), random_hex(16)),
        ts: iso_now_utc(),
        kind,
        extra,
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

fn reduce_to_snapshot(records: &[Record]) -> Result<Snapshot, BlackboardError> {
    let mut snap = Snapshot {
        schema: SCHEMA.to_string(),
        ..Snapshot::default()
    };

    for record in records {
        *snap.counts.entry(record.kind).or_insert(0) += 1;

        match record.kind {
            RecordKind::TaskClaim => {
                let task_id = match record.get_str("taskId") {
                    Some(s) => s.to_string(),
                    None => continue,
                };
                snap.tasks.insert(
                    task_id,
                    TaskState {
                        agent: record.get_str("agent").unwrap_or("").to_string(),
                        summary: record.get_str("summary").unwrap_or("").to_string(),
                        status: record.get_str("status").unwrap_or("claimed").to_string(),
                        claimed_at: record.ts.clone(),
                        result_at: None,
                    },
                );
            }
            RecordKind::PathClaim => {
                let path = match record.get_str("path") {
                    Some(s) => s.to_string(),
                    None => continue,
                };
                snap.path_claims.insert(
                    path,
                    PathClaimState {
                        agent: record.get_str("agent").unwrap_or("").to_string(),
                        task_id: record.get_str("taskId").unwrap_or("").to_string(),
                        mode: record.get_str("mode").unwrap_or("").to_string(),
                        reason: record.get_str("reason").unwrap_or("").to_string(),
                        claimed_at: record.ts.clone(),
                    },
                );
            }
            RecordKind::PathRelease => {
                let path = match record.get_str("path") {
                    Some(s) => s.to_string(),
                    None => continue,
                };
                if let Some(existing) = snap.path_claims.get(&path) {
                    if existing.agent == record.get_str("agent").unwrap_or("")
                        && existing.task_id == record.get_str("taskId").unwrap_or("")
                    {
                        snap.path_claims.remove(&path);
                    }
                }
            }
            RecordKind::Fact => snap.facts.push(record.clone()),
            RecordKind::Decision => snap.decisions.push(record.clone()),
            RecordKind::Result => {
                snap.results.push(record.clone());
                let task_id = record.get_str("taskId").unwrap_or("").to_string();
                if let Some(task) = snap.tasks.get_mut(&task_id) {
                    let ok = record.get_bool("ok").unwrap_or(false);
                    task.status = if ok { "done".into() } else { "failed".into() };
                    task.result_at = Some(record.ts.clone());
                }
            }
        }
    }

    Ok(snap)
}
