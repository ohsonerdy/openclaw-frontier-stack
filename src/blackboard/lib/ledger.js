'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA = 'openclaw-frontier.blackboard-ledger.v1';
const VALID_KINDS = new Set([
  'task-claim',
  'path-claim',
  'path-release',
  'fact',
  'decision',
  'result',
]);

const SECRETISH_SEGMENTS = [
  /^\.?env(?:\..*)?$/i,
  /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$/i,
  /\.(?:pem|key|p12|pfx|kdbx)$/i,
  /(?:^|[-_.])(?:secret|secrets|token|tokens|credential|credentials|password|passwd|private|api-key|apikey|auth|oauth|cookie|session|vault)(?:[-_.]|$)/i,
  /(?:^|[-_.])(?:key|keys)(?:[-_.]|$)/i,
];

const PUBLIC_SAFETY_PATTERNS = [
  { id: 'posix-home-path', regex: /\/Users\/[A-Za-z0-9._-]+(?:\/|$)/ },
  { id: 'windows-home-path', regex: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+(?:\\|$)/ },
  { id: 'private-key-block', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'api-key-shape', regex: /\b(?:sk-[A-Za-z0-9_-]{20,}|(?:ghp|github_pat)_[A-Za-z0-9_]{20,}|xox[abpors]-[A-Za-z0-9-]{20,})\b/ },
  { id: 'telegram-token-shape', regex: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/ },
  { id: 'ipv4-address', regex: /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/ },
];

class BlackboardValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'BlackboardValidationError';
    this.code = 'BLACKBOARD_VALIDATION';
    this.details = details;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) {
    throw new BlackboardValidationError(`${label} must be an object`);
  }
}

function requireString(value, field, opts = {}) {
  if (typeof value !== 'string') {
    throw new BlackboardValidationError(`${field} must be a string`, { field });
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new BlackboardValidationError(`${field} must not be empty`, { field });
  }
  if (opts.maxLength && trimmed.length > opts.maxLength) {
    throw new BlackboardValidationError(`${field} exceeds ${opts.maxLength} characters`, { field });
  }
  return trimmed;
}

function validateAgentId(value, field = 'agent') {
  const agent = requireString(value, field, { maxLength: 64 });
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(agent)) {
    throw new BlackboardValidationError(`${field} must be a simple agent id`, { field });
  }
  return agent;
}

function validateTaskId(value, field = 'taskId') {
  const taskId = requireString(value, field, { maxLength: 128 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(taskId)) {
    throw new BlackboardValidationError(`${field} must be a simple task id`, { field });
  }
  return taskId;
}

function normalizeRecordPath(input) {
  const raw = requireString(input, 'path', { maxLength: 512 });
  if (raw.includes('\0') || /[\r\n]/.test(raw)) {
    throw new BlackboardValidationError('path contains invalid control characters', { path: raw });
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) {
    throw new BlackboardValidationError('path must not be a URL', { path: raw });
  }
  if (path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw) || /^~(?:[\\/]|$)/.test(raw)) {
    throw new BlackboardValidationError('path must be relative', { path: raw });
  }

  const forward = raw.replace(/\\/g, '/');
  const parts = forward.split('/');
  if (parts.some((part) => part === '' || part === '.')) {
    throw new BlackboardValidationError('path must not contain empty or dot segments', { path: raw });
  }
  if (parts.includes('..')) {
    throw new BlackboardValidationError('path must not contain parent-directory segments', { path: raw });
  }
  for (const part of parts) {
    if (SECRETISH_SEGMENTS.some((regex) => regex.test(part))) {
      throw new BlackboardValidationError('path contains a secret-like segment name', { path: raw, segment: part });
    }
  }

  const normalized = path.posix.normalize(forward);
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new BlackboardValidationError('path must stay inside the workspace-relative namespace', { path: raw });
  }
  return normalized;
}

function validatePublicSafeRecord(record) {
  let text;
  try {
    text = JSON.stringify(record);
  } catch (err) {
    throw new BlackboardValidationError(`record is not JSON serializable: ${err.message}`);
  }
  for (const pattern of PUBLIC_SAFETY_PATTERNS) {
    if (pattern.regex.test(text)) {
      throw new BlackboardValidationError(`record failed production-safety scan: ${pattern.id}`, { pattern: pattern.id });
    }
  }
}

function normalizeArtifactPaths(artifacts) {
  if (artifacts == null) return [];
  if (!Array.isArray(artifacts)) {
    throw new BlackboardValidationError('artifacts must be an array of relative paths');
  }
  return artifacts.map((artifact) => normalizeRecordPath(artifact));
}

function createId(kind) {
  const suffix = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  return `${kind}-${suffix}`;
}

function withBaseFields(kind, fields) {
  const record = {
    schema: SCHEMA,
    id: createId(kind),
    ts: new Date().toISOString(),
    kind,
    ...fields,
  };
  validatePublicSafeRecord(record);
  return record;
}

function parseJsonl(text, source = 'ledger') {
  const records = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch (err) {
      throw new BlackboardValidationError(`invalid JSONL at ${source}:${index + 1}: ${err.message}`, {
        source,
        line: index + 1,
      });
    }
  }
  return records;
}

function sleepSync(ms) {
  const shared = new SharedArrayBuffer(4);
  const view = new Int32Array(shared);
  Atomics.wait(view, 0, 0, ms);
}

class BlackboardLedger {
  constructor(options = {}) {
    const ledgerPath = options.ledgerPath || path.join(process.cwd(), 'blackboard.jsonl');
    this.ledgerPath = path.resolve(ledgerPath);
    this.lockPath = options.lockPath || `${this.ledgerPath}.lock`;
    this.lockTimeoutMs = options.lockTimeoutMs || 10000;
    this.staleLockMs = options.staleLockMs || 30000;
  }

  ensureDirectory() {
    fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
  }

  withLedgerLock(fn) {
    this.ensureDirectory();
    const started = Date.now();
    let acquired = false;
    while (!acquired) {
      try {
        fs.mkdirSync(this.lockPath, { mode: 0o700 });
        fs.writeFileSync(
          path.join(this.lockPath, 'owner.json'),
          JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }) + '\n',
          'utf8',
        );
        acquired = true;
      } catch (err) {
        if (!['EEXIST', 'EPERM'].includes(err.code)) throw err;
        let stale = false;
        try {
          const st = fs.statSync(this.lockPath);
          stale = Date.now() - st.mtimeMs > this.staleLockMs;
        } catch (_) {
          stale = false;
        }
        if (stale) {
          fs.rmSync(this.lockPath, { recursive: true, force: true });
          continue;
        }
        if (Date.now() - started > this.lockTimeoutMs) {
          throw new BlackboardValidationError('ledger lock timeout', {
            lockPath: path.basename(this.lockPath),
            timeoutMs: this.lockTimeoutMs,
          });
        }
        sleepSync(5 + Math.floor(Math.random() * 15));
      }
    }

    try {
      return fn();
    } finally {
      fs.rmSync(this.lockPath, { recursive: true, force: true });
    }
  }

  append(record) {
    return this.withLedgerLock(() => this.appendUnlocked(record));
  }

  appendUnlocked(record) {
    assertPlainObject(record, 'record');
    if (!VALID_KINDS.has(record.kind)) {
      throw new BlackboardValidationError(`invalid record kind: ${record.kind}`, { kind: record.kind });
    }
    validatePublicSafeRecord(record);
    this.ensureDirectory();
    const line = JSON.stringify(record) + '\n';
    const fd = fs.openSync(this.ledgerPath, 'a', 0o600);
    try {
      fs.writeSync(fd, line, null, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return record;
  }

  readRecords() {
    if (!fs.existsSync(this.ledgerPath)) return [];
    const text = fs.readFileSync(this.ledgerPath, 'utf8');
    const records = parseJsonl(text, this.ledgerPath);
    for (const record of records) {
      validatePublicSafeRecord(record);
    }
    return records;
  }

  claimTask({ agent, taskId, summary, forRole = null }) {
    const fields = {
      agent: validateAgentId(agent),
      taskId: validateTaskId(taskId),
      summary: requireString(summary, 'summary', { maxLength: 500 }),
      status: 'claimed',
    };
    // Optional routing field. When present, identifies the lane role that
    // should pick this claim off the ledger. The orchestrator is still the
    // record AUTHOR (the `agent` field); `forRole` lets a live agent daemon
    // filter to claims addressed to it without inferring intent from the
    // task id naming. Legacy claims (no forRole) still validate; live agents
    // fall back to `agent` for those (see bin/openclaw-agent#findPendingClaims).
    if (forRole != null) {
      fields.forRole = validateAgentId(forRole, 'forRole');
    }
    const record = withBaseFields('task-claim', fields);
    return this.append(record);
  }

  claimPath({ agent, taskId, path: claimPath, mode = 'write', reason = '' }) {
    return this.withLedgerLock(() => {
      const normalizedPath = normalizeRecordPath(claimPath);
      const snapshot = this.snapshot();
      const existing = snapshot.pathClaims[normalizedPath];
      if (existing && (existing.agent !== agent || existing.taskId !== taskId)) {
        throw new BlackboardValidationError('path is already claimed', {
          path: normalizedPath,
          claimedBy: existing.agent,
          taskId: existing.taskId,
        });
      }
      const record = withBaseFields('path-claim', {
        agent: validateAgentId(agent),
        taskId: validateTaskId(taskId),
        path: normalizedPath,
        mode: requireString(mode, 'mode', { maxLength: 32 }),
        reason: reason ? requireString(reason, 'reason', { maxLength: 500 }) : '',
      });
      return this.appendUnlocked(record);
    });
  }

  releasePath({ agent, taskId, path: releasePath, reason = '' }) {
    const record = withBaseFields('path-release', {
      agent: validateAgentId(agent),
      taskId: validateTaskId(taskId),
      path: normalizeRecordPath(releasePath),
      reason: reason ? requireString(reason, 'reason', { maxLength: 500 }) : '',
    });
    return this.append(record);
  }

  recordFact({ agent, subject, value, evidence = [] }) {
    if (evidence != null && !Array.isArray(evidence)) {
      throw new BlackboardValidationError('evidence must be an array');
    }
    const record = withBaseFields('fact', {
      agent: validateAgentId(agent),
      subject: requireString(subject, 'subject', { maxLength: 200 }),
      value: value == null ? null : value,
      evidence: evidence || [],
    });
    return this.append(record);
  }

  recordDecision({ agent, taskId = '', decision, status = 'accepted', rationale = '' }) {
    const fields = {
      agent: validateAgentId(agent),
      decision: requireString(decision, 'decision', { maxLength: 200 }),
      status: requireString(status, 'status', { maxLength: 64 }),
      rationale: rationale ? requireString(rationale, 'rationale', { maxLength: 1000 }) : '',
    };
    if (taskId) fields.taskId = validateTaskId(taskId);
    const record = withBaseFields('decision', fields);
    return this.append(record);
  }

  recordResult({ agent, taskId, ok, summary, artifacts = [] }) {
    const record = withBaseFields('result', {
      agent: validateAgentId(agent),
      taskId: validateTaskId(taskId),
      ok: Boolean(ok),
      summary: requireString(summary, 'summary', { maxLength: 1000 }),
      artifacts: normalizeArtifactPaths(artifacts),
    });
    return this.append(record);
  }

  snapshot() {
    const records = this.readRecords();
    const state = {
      schema: SCHEMA,
      tasks: {},
      pathClaims: {},
      facts: [],
      decisions: [],
      results: [],
      counts: {},
    };

    for (const record of records) {
      state.counts[record.kind] = (state.counts[record.kind] || 0) + 1;
      if (record.kind === 'task-claim') {
        state.tasks[record.taskId] = {
          agent: record.agent,
          summary: record.summary,
          status: record.status,
          claimedAt: record.ts,
        };
      } else if (record.kind === 'path-claim') {
        state.pathClaims[record.path] = {
          agent: record.agent,
          taskId: record.taskId,
          mode: record.mode,
          reason: record.reason,
          claimedAt: record.ts,
        };
      } else if (record.kind === 'path-release') {
        const existing = state.pathClaims[record.path];
        if (existing && existing.agent === record.agent && existing.taskId === record.taskId) {
          delete state.pathClaims[record.path];
        }
      } else if (record.kind === 'fact') {
        state.facts.push(record);
      } else if (record.kind === 'decision') {
        state.decisions.push(record);
      } else if (record.kind === 'result') {
        state.results.push(record);
        if (state.tasks[record.taskId]) {
          state.tasks[record.taskId].status = record.ok ? 'done' : 'failed';
          state.tasks[record.taskId].resultAt = record.ts;
        }
      }
    }

    return state;
  }
}

function createLedger(options) {
  return new BlackboardLedger(options);
}

module.exports = {
  SCHEMA,
  VALID_KINDS: Array.from(VALID_KINDS),
  BlackboardLedger,
  BlackboardValidationError,
  createLedger,
  normalizeRecordPath,
  parseJsonl,
  validatePublicSafeRecord,
};
