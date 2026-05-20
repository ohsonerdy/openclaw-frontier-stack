'use strict';

/**
 * ticket-store — proper ticket FSM on top of the blackboard/taskflow primitives.
 *
 * This is a sibling layer to `src/blackboard/lib/ledger.js` (operational state)
 * and `src/taskflow/lib/taskflow.js` (in-flight goal execution). Tickets are
 * intentionally repo-wide and survive across sessions; the blackboard is
 * per-project.
 *
 * The store is event-sourced: every transition appends one line of JSONL to
 * `release-gate/tickets.jsonl` (or whatever `ticketsPath` you pass). The
 * current state of every ticket is computed by replaying the log via
 * `snapshot()`.
 *
 * Lifecycle (FSM):
 *
 *     open ──claim──▶ in-progress ──requestReview──▶ review
 *      │                  │  ▲                          │
 *      │                  │  └────requestChanges────────┤
 *      │                  │                             │
 *      │                  └────close(cancel)────────┐  approveReview
 *      │                                            │   │
 *      │                                            ▼   ▼
 *      └────close(cancel)──────────────────▶ archived ◀──done
 *                                                ▲      │
 *                                                │      └──reopen──▶ in-progress
 *                                                └────close─────────┘
 *
 * A ticket also carries a derived `blocked` flag when one of its dependencies
 * is not yet `done` (or `archived` via approve, not via cancel). The blocked
 * flag is not a separate FSM state — it is a query-time annotation surfaced by
 * `snapshot()`, `get()`, and `list({ blockedBy })`. This mirrors how taskflow
 * surfaces queued-vs-claimed without needing an explicit "blocked" terminal.
 *
 * Invalid transitions throw TicketStateError. Validation errors throw
 * TicketValidationError. Both subclass Error so callers can `catch` either or
 * both.
 *
 * The lock pattern (mkdir lockdir + sleep-spin with stale-lock recovery) is
 * lifted directly from BlackboardLedger so we get the same single-writer
 * guarantee on cross-platform fs.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA = 'openclaw-frontier.ticket-store.v1';

const STATES = Object.freeze(['open', 'in-progress', 'review', 'done', 'archived']);
const TERMINAL_STATES = new Set(['archived']);
const PRIORITIES = new Set(['p0', 'p1', 'p2']);

// FSM transitions: source -> set of allowed target states.
const TRANSITIONS = Object.freeze({
  open: new Set(['in-progress', 'archived']),
  'in-progress': new Set(['review', 'archived']),
  review: new Set(['in-progress', 'done']),
  done: new Set(['in-progress', 'archived']),
  archived: new Set(['in-progress']),
});

const VALID_KINDS = new Set([
  'ticket-opened',
  'ticket-assigned',
  'ticket-claimed',
  'ticket-review-requested',
  'ticket-review-approved',
  'ticket-changes-requested',
  'ticket-closed',
  'ticket-reopened',
  'ticket-dependency-added',
  'ticket-dependency-removed',
  // v0.8.0 additions — every new transition is its own event kind so the JSONL
  // log stays self-describing and v1 readers can ignore unknown kinds rather
  // than crashing. Each handler in `snapshot()` is keyed off these strings.
  'ticket-assignee-added',
  'ticket-assignee-removed',
  'ticket-watcher-added',
  'ticket-watcher-removed',
  'ticket-attachment-added',
  'ticket-sla-paused',
  'ticket-sla-resumed',
  'ticket-goal-bound',
  'ticket-goal-unbound',
  'ticket-goal-reconciled',
]);

class TicketValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'TicketValidationError';
    this.code = 'TICKET_VALIDATION';
    this.details = details;
  }
}

class TicketStateError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'TicketStateError';
    this.code = 'TICKET_STATE';
    this.details = details;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value, field, opts = {}) {
  if (typeof value !== 'string') {
    throw new TicketValidationError(`${field} must be a string`, { field });
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new TicketValidationError(`${field} must not be empty`, { field });
  }
  if (opts.maxLength && trimmed.length > opts.maxLength) {
    throw new TicketValidationError(`${field} exceeds ${opts.maxLength} characters`, { field });
  }
  return trimmed;
}

function validateAgentId(value, field = 'agent') {
  const agent = requireString(value, field, { maxLength: 64 });
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(agent)) {
    throw new TicketValidationError(`${field} must be a simple agent id`, { field, value });
  }
  return agent;
}

function validateTicketId(value, field = 'id') {
  const id = requireString(value, field, { maxLength: 128 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) {
    throw new TicketValidationError(`${field} must be a simple ticket id`, { field, value });
  }
  return id;
}

function validatePriority(value) {
  const p = requireString(value, 'priority', { maxLength: 8 }).toLowerCase();
  if (!PRIORITIES.has(p)) {
    throw new TicketValidationError(`priority must be one of: ${Array.from(PRIORITIES).join(', ')}`, { value });
  }
  return p;
}

function validateSlaHours(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 24 * 365) {
    throw new TicketValidationError('slaHours must be a positive finite number ≤ 24*365', { value });
  }
  return n;
}

const PUBLIC_SAFETY_PATTERNS = [
  { id: 'posix-home-path', regex: /\/Users\/[A-Za-z0-9._-]+(?:\/|$)/ },
  { id: 'windows-home-path', regex: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+(?:\\|$)/ },
  { id: 'private-key-block', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'api-key-shape', regex: /\b(?:sk-[A-Za-z0-9_-]{20,}|(?:ghp|github_pat)_[A-Za-z0-9_]{20,}|xox[abpors]-[A-Za-z0-9-]{20,})\b/ },
  { id: 'telegram-token-shape', regex: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/ },
];

function validatePublicSafe(record) {
  const text = JSON.stringify(record);
  for (const pattern of PUBLIC_SAFETY_PATTERNS) {
    if (pattern.regex.test(text)) {
      throw new TicketValidationError(`record failed public-safety scan: ${pattern.id}`, { pattern: pattern.id });
    }
  }
}

function genId(prefix) {
  const suffix = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  return `${prefix}-${suffix}`;
}

function parseJsonl(text, source = 'tickets') {
  const records = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch (err) {
      throw new TicketValidationError(`invalid JSONL at ${source}:${index + 1}: ${err.message}`, {
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

function hoursBetween(fromISO, toISO) {
  const a = Date.parse(fromISO);
  const b = Date.parse(toISO);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / 3600000;
}

function validateIsoTimestamp(value, field) {
  if (typeof value !== 'string') {
    throw new TicketValidationError(`${field} must be an ISO timestamp string`, { field });
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new TicketValidationError(`${field} is not a parseable ISO timestamp`, { field, value });
  }
  return value;
}

function validateRelativePath(value, field = 'path') {
  const v = requireString(value, field, { maxLength: 2048 });
  if (path.isAbsolute(v)) {
    throw new TicketValidationError(`${field} must be a relative path, not absolute`, { field, value: v });
  }
  if (v.split(/[/\\]/).some((seg) => seg === '..')) {
    throw new TicketValidationError(`${field} must not contain '..' segments`, { field, value: v });
  }
  // Use POSIX-style separator on disk, so windows + posix records compare cleanly.
  return v.replace(/\\/g, '/');
}

function isHexSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function dedupeStringList(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * pausedHours(windows, fromISO, toISO) — total hours overlapping any pause
 * window inside [fromISO, toISO]. Open-ended windows (no `to` field, meaning
 * "still paused") are treated as paused up to toISO. Windows that start before
 * fromISO are clipped at fromISO. Windows that end after toISO are clipped at
 * toISO. We use ms math to avoid fp accumulation across many windows.
 */
function pausedHours(windows, fromISO, toISO) {
  if (!Array.isArray(windows) || windows.length === 0) return 0;
  const fromMs = Date.parse(fromISO);
  const toMs = Date.parse(toISO);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return 0;
  let totalMs = 0;
  // Merge overlapping windows so a malformed double-pause doesn't double-count.
  const normalized = [];
  for (const w of windows) {
    const startMs = Date.parse(w.from);
    const endMs = w.to ? Date.parse(w.to) : toMs;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    if (endMs <= startMs) continue;
    normalized.push([Math.max(startMs, fromMs), Math.min(endMs, toMs)]);
  }
  if (!normalized.length) return 0;
  normalized.sort((a, b) => a[0] - b[0]);
  let [curStart, curEnd] = normalized[0];
  for (let i = 1; i < normalized.length; i += 1) {
    const [s, e] = normalized[i];
    if (s <= curEnd) {
      if (e > curEnd) curEnd = e;
    } else {
      if (curEnd > curStart) totalMs += curEnd - curStart;
      curStart = s;
      curEnd = e;
    }
  }
  if (curEnd > curStart) totalMs += curEnd - curStart;
  return totalMs / 3600000;
}

class TicketStore {
  constructor(options = {}) {
    const ticketsPath = options.ticketsPath
      || process.env.OPENCLAW_TICKETS_PATH
      || path.join(process.cwd(), 'release-gate', 'tickets.jsonl');
    this.ticketsPath = path.resolve(ticketsPath);
    this.lockPath = options.lockPath || `${this.ticketsPath}.lock`;
    this.lockTimeoutMs = options.lockTimeoutMs || 10000;
    this.staleLockMs = options.staleLockMs || 30000;
    this.now = options.now || (() => new Date().toISOString());
  }

  ensureDirectory() {
    fs.mkdirSync(path.dirname(this.ticketsPath), { recursive: true });
  }

  withLock(fn) {
    this.ensureDirectory();
    const started = Date.now();
    let acquired = false;
    while (!acquired) {
      try {
        fs.mkdirSync(this.lockPath, { mode: 0o700 });
        fs.writeFileSync(
          path.join(this.lockPath, 'owner.json'),
          JSON.stringify({ pid: process.pid, acquiredAt: this.now() }) + '\n',
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
          throw new TicketValidationError('ticket store lock timeout', {
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

  appendUnlocked(kind, body) {
    if (!VALID_KINDS.has(kind)) {
      throw new TicketValidationError(`invalid event kind: ${kind}`, { kind });
    }
    const record = {
      schema: SCHEMA,
      id: genId(kind),
      ts: this.now(),
      kind,
      ...body,
    };
    validatePublicSafe(record);
    this.ensureDirectory();
    const line = JSON.stringify(record) + '\n';
    const fd = fs.openSync(this.ticketsPath, 'a', 0o600);
    try {
      fs.writeSync(fd, line, null, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return record;
  }

  // Internal: build the notify recipient list for a state-change event. We
  // include every watcher + every current assignee, then subtract the actor
  // (`by`) since the actor doesn't need to be told about their own action.
  // The downstream notification system reads `record.notify` off the JSONL.
  notifyListFor(ticket, by) {
    if (!ticket) return [];
    const recipients = [];
    for (const w of Array.isArray(ticket.watchers) ? ticket.watchers : []) recipients.push(w);
    for (const a of Array.isArray(ticket.assignees) ? ticket.assignees : []) recipients.push(a);
    if (ticket.reviewer) recipients.push(ticket.reviewer);
    return dedupeStringList(recipients).filter((r) => r && r !== by);
  }

  readRecords() {
    if (!fs.existsSync(this.ticketsPath)) return [];
    const text = fs.readFileSync(this.ticketsPath, 'utf8');
    return parseJsonl(text, this.ticketsPath);
  }

  // ------------------------------------------------------------------------
  // Snapshot: replay events into the current state of every ticket.
  // ------------------------------------------------------------------------

  snapshot() {
    const records = this.readRecords();
    const tickets = {};
    const counts = {};

    for (const record of records) {
      counts[record.kind] = (counts[record.kind] || 0) + 1;
      const id = record.ticketId;
      if (!id) continue;

      if (record.kind === 'ticket-opened') {
        // v0.8.0 schema additions default to empty / null for back-compat with
        // v1 records — a v1 `ticket-opened` will have no assignees / watchers /
        // attachments / pause-windows / goalId field, and the snapshot still
        // works.
        const initialAssignees = [];
        if (record.assignedTo) initialAssignees.push(record.assignedTo);
        tickets[id] = {
          id,
          title: record.title,
          body: record.body || '',
          state: 'open',
          priority: record.priority,
          assignedTo: record.assignedTo || null,
          assignees: initialAssignees,
          watchers: [],
          attachments: [],
          slaPauseWindows: [],
          goalId: record.goalId || null,
          template: record.template || null,
          dependsOn: Array.isArray(record.dependsOn) ? record.dependsOn.slice() : [],
          slaHours: record.slaHours != null ? record.slaHours : null,
          createdAt: record.ts,
          createdBy: record.by,
          updatedAt: record.ts,
          history: [{ id: record.id, kind: record.kind, ts: record.ts, by: record.by }],
          resolution: null,
          reviewer: null,
        };
        continue;
      }

      const ticket = tickets[id];
      if (!ticket) continue; // event for unknown ticket — ignore, JSONL drift defence
      ticket.history.push({ id: record.id, kind: record.kind, ts: record.ts, by: record.by });
      ticket.updatedAt = record.ts;
      // v0.8.0: defensive defaults so v1 records replayed under v2 code still
      // expose the new collections instead of `undefined`. The constructor in
      // ticket-opened sets these, but a v1 record on disk does not — back-fill
      // here on first touch.
      if (!Array.isArray(ticket.assignees)) {
        ticket.assignees = ticket.assignedTo ? [ticket.assignedTo] : [];
      }
      if (!Array.isArray(ticket.watchers)) ticket.watchers = [];
      if (!Array.isArray(ticket.attachments)) ticket.attachments = [];
      if (!Array.isArray(ticket.slaPauseWindows)) ticket.slaPauseWindows = [];
      if (ticket.goalId === undefined) ticket.goalId = null;

      switch (record.kind) {
        case 'ticket-assigned':
          ticket.assignedTo = record.to;
          if (!ticket.assignees.includes(record.to)) ticket.assignees.push(record.to);
          break;
        case 'ticket-claimed':
          ticket.state = 'in-progress';
          ticket.assignedTo = record.by;
          if (!ticket.assignees.includes(record.by)) ticket.assignees.push(record.by);
          break;
        case 'ticket-review-requested':
          ticket.state = 'review';
          ticket.reviewer = record.reviewer;
          break;
        case 'ticket-review-approved':
          ticket.state = 'done';
          ticket.resolvedAt = record.ts;
          ticket.resolution = ticket.resolution || 'approved';
          break;
        case 'ticket-changes-requested':
          ticket.state = 'in-progress';
          ticket.lastReviewComment = record.comment || '';
          break;
        case 'ticket-closed':
          ticket.state = 'archived';
          ticket.resolution = record.resolution;
          ticket.closedAt = record.ts;
          break;
        case 'ticket-reopened':
          ticket.state = 'in-progress';
          ticket.reopenedAt = record.ts;
          ticket.lastReopenReason = record.reason;
          break;
        case 'ticket-dependency-added':
          if (!ticket.dependsOn.includes(record.dependsOn)) ticket.dependsOn.push(record.dependsOn);
          break;
        case 'ticket-dependency-removed':
          ticket.dependsOn = ticket.dependsOn.filter((d) => d !== record.dependsOn);
          break;
        case 'ticket-assignee-added':
          if (!ticket.assignees.includes(record.assignee)) ticket.assignees.push(record.assignee);
          // Primary assignee follows the first assignment if there isn't one
          // yet. Beyond that we leave assignedTo alone — explicit re-assign or
          // claim updates the primary.
          if (!ticket.assignedTo) ticket.assignedTo = record.assignee;
          break;
        case 'ticket-assignee-removed':
          ticket.assignees = ticket.assignees.filter((a) => a !== record.assignee);
          if (ticket.assignedTo === record.assignee) {
            ticket.assignedTo = ticket.assignees[0] || null;
          }
          break;
        case 'ticket-watcher-added':
          if (!ticket.watchers.includes(record.watcher)) ticket.watchers.push(record.watcher);
          break;
        case 'ticket-watcher-removed':
          ticket.watchers = ticket.watchers.filter((w) => w !== record.watcher);
          break;
        case 'ticket-attachment-added':
          ticket.attachments.push({
            path: record.path,
            addedBy: record.by,
            addedAt: record.ts,
            sha256: record.sha256,
            bytes: record.bytes != null ? record.bytes : null,
          });
          break;
        case 'ticket-sla-paused':
          ticket.slaPauseWindows.push({
            from: record.ts,
            to: record.until || null,
            reason: record.reason,
            pausedBy: record.by,
          });
          break;
        case 'ticket-sla-resumed': {
          // Close the most recent open-ended window (one with `to === null`).
          // If none exists, treat as a no-op replay defence; the API
          // `clearSlaPause` validates there is an active pause at write time.
          for (let k = ticket.slaPauseWindows.length - 1; k >= 0; k -= 1) {
            if (ticket.slaPauseWindows[k].to == null) {
              ticket.slaPauseWindows[k].to = record.ts;
              ticket.slaPauseWindows[k].resumedBy = record.by;
              break;
            }
          }
          break;
        }
        case 'ticket-goal-bound':
          ticket.goalId = record.goalId;
          break;
        case 'ticket-goal-unbound':
          ticket.goalId = null;
          break;
        case 'ticket-goal-reconciled':
          // The actual FSM transition or block flag is replayed via a paired
          // event already (review-requested / closed). The reconciled record
          // is informational so operators can see the binding fired.
          ticket.lastGoalReconciliation = {
            ts: record.ts,
            goalId: record.goalId,
            goalState: record.goalState,
            action: record.action,
          };
          if (record.goalState === 'failed' && record.action === 'block') {
            ticket.goalBlockReason = record.reason || 'goal-failed';
          }
          if (record.goalState !== 'failed' && ticket.goalBlockReason) {
            ticket.goalBlockReason = null;
          }
          break;
        default:
          break;
      }
    }

    // Derived blocked flag: a ticket is blocked if at least one of its
    // dependencies is not in {done, archived-via-approval}. We treat
    // archived-via-cancel (resolution !== 'approved' and !== 'done') as
    // still satisfying a dependency, on the theory that explicit cancel
    // is a closure too. This matches operator expectation: if I cancel
    // an upstream ticket, downstream is no longer waiting on it.
    for (const ticket of Object.values(tickets)) {
      ticket.blockedBy = ticket.dependsOn.filter((depId) => {
        const dep = tickets[depId];
        if (!dep) return true; // dep missing — treat as blocking
        return dep.state !== 'done' && dep.state !== 'archived';
      });
      const depBlocked = ticket.blockedBy.length > 0 && (ticket.state === 'open' || ticket.state === 'in-progress');
      // A goal-failed reconciliation sets goalBlockReason. We honour that as an
      // additional blocking signal so list({ blockedBy: true }) surfaces both
      // upstream-ticket blocks and goal-driven blocks under one flag.
      const goalBlocked = Boolean(ticket.goalBlockReason)
        && (ticket.state === 'open' || ticket.state === 'in-progress');
      ticket.blocked = depBlocked || goalBlocked;
    }

    return { schema: SCHEMA, tickets, counts, recordCount: records.length };
  }

  get({ id } = {}) {
    const safeId = validateTicketId(id);
    const snap = this.snapshot();
    return snap.tickets[safeId] || null;
  }

  list(filter = {}) {
    const snap = this.snapshot();
    const items = Object.values(snap.tickets);
    return items.filter((t) => {
      if (filter.status && t.state !== filter.status) return false;
      if (filter.assignedTo) {
        // Match either the singular primary or the multi-assignee list. This
        // keeps the v1 filter behaviour (assignedTo === single agent) working
        // even when callers add additional assignees via addAssignee.
        const inAssignees = Array.isArray(t.assignees) && t.assignees.includes(filter.assignedTo);
        if (t.assignedTo !== filter.assignedTo && !inAssignees) return false;
      }
      if (filter.watcher) {
        if (!Array.isArray(t.watchers) || !t.watchers.includes(filter.watcher)) return false;
      }
      if (filter.priority && t.priority !== filter.priority) return false;
      if (filter.goalId && t.goalId !== filter.goalId) return false;
      if (filter.template && t.template !== filter.template) return false;
      if (filter.blockedBy === true && !t.blocked) return false;
      if (filter.blockedBy === false && t.blocked) return false;
      if (filter.since) {
        const sinceMs = Date.parse(filter.since);
        const updMs = Date.parse(t.updatedAt);
        if (Number.isFinite(sinceMs) && Number.isFinite(updMs) && updMs < sinceMs) return false;
      }
      return true;
    }).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // ------------------------------------------------------------------------
  // Transitions.
  // ------------------------------------------------------------------------

  open({
    id, title, body = '', by, assignedTo = null, priority = 'p2', dependsOn = [], slaHours = null,
    goalId = null, template = null,
  } = {}) {
    const ticketId = id ? validateTicketId(id) : genId('ticket');
    const safeTitle = requireString(title, 'title', { maxLength: 200 });
    // bodyTemplate skeletons routinely run past the v1 5KB body limit. Bump
    // the cap to 20KB so templated bug-reports / postmortems still fit.
    const safeBody = body ? requireString(body, 'body', { maxLength: 20000 }) : '';
    const safeBy = validateAgentId(by, 'by');
    const safeAssigned = assignedTo ? validateAgentId(assignedTo, 'assignedTo') : null;
    const safePriority = validatePriority(priority);
    if (!Array.isArray(dependsOn)) throw new TicketValidationError('dependsOn must be an array');
    const safeDeps = dependsOn.map((d) => validateTicketId(d, 'dependsOn'));
    const safeSla = validateSlaHours(slaHours);
    const safeGoalId = goalId != null ? validateTicketId(goalId, 'goalId') : null;
    const safeTemplate = template != null
      ? requireString(template, 'template', { maxLength: 64 })
      : null;

    return this.withLock(() => {
      const snap = this.snapshot();
      if (snap.tickets[ticketId]) {
        throw new TicketStateError('ticket id already exists', { id: ticketId });
      }
      for (const depId of safeDeps) {
        if (!snap.tickets[depId]) {
          throw new TicketStateError('dependency does not exist', { id: ticketId, dependsOn: depId });
        }
      }
      return this.appendUnlocked('ticket-opened', {
        ticketId,
        title: safeTitle,
        body: safeBody,
        by: safeBy,
        assignedTo: safeAssigned,
        priority: safePriority,
        dependsOn: safeDeps,
        slaHours: safeSla,
        goalId: safeGoalId,
        template: safeTemplate,
      });
    });
  }

  assign({ id, to, by } = {}) {
    const ticketId = validateTicketId(id);
    const safeTo = validateAgentId(to, 'to');
    const safeBy = validateAgentId(by, 'by');
    return this.withLock(() => {
      const ticket = this.snapshot().tickets[ticketId];
      if (!ticket) throw new TicketStateError('ticket does not exist', { id: ticketId });
      if (TERMINAL_STATES.has(ticket.state)) {
        throw new TicketStateError(`cannot assign a ${ticket.state} ticket`, { id: ticketId, state: ticket.state });
      }
      return this.appendUnlocked('ticket-assigned', { ticketId, to: safeTo, by: safeBy });
    });
  }

  claim({ id, by } = {}) {
    const ticketId = validateTicketId(id);
    const safeBy = validateAgentId(by, 'by');
    return this.withLock(() => {
      const ticket = this.snapshot().tickets[ticketId];
      if (!ticket) throw new TicketStateError('ticket does not exist', { id: ticketId });
      // claim is strictly open -> in-progress. Re-entering in-progress from
      // done|archived is done via reopen, not claim. This guarantees a claim
      // event always represents an initial pickup rather than a re-pickup.
      if (ticket.state !== 'open') {
        throw new TicketStateError(`cannot claim a ${ticket.state} ticket`, { id: ticketId, state: ticket.state });
      }
      const notify = this.notifyListFor(ticket, safeBy);
      return this.appendUnlocked('ticket-claimed', { ticketId, by: safeBy, notify });
    });
  }

  requestReview({ id, by, reviewer } = {}) {
    const ticketId = validateTicketId(id);
    const safeBy = validateAgentId(by, 'by');
    const safeReviewer = validateAgentId(reviewer, 'reviewer');
    return this.withLock(() => {
      const ticket = this.snapshot().tickets[ticketId];
      if (!ticket) throw new TicketStateError('ticket does not exist', { id: ticketId });
      this.assertTransition(ticket, 'review');
      const notify = this.notifyListFor(ticket, safeBy);
      return this.appendUnlocked('ticket-review-requested', {
        ticketId, by: safeBy, reviewer: safeReviewer, notify,
      });
    });
  }

  approveReview({ id, by } = {}) {
    const ticketId = validateTicketId(id);
    const safeBy = validateAgentId(by, 'by');
    return this.withLock(() => {
      const ticket = this.snapshot().tickets[ticketId];
      if (!ticket) throw new TicketStateError('ticket does not exist', { id: ticketId });
      this.assertTransition(ticket, 'done');
      const notify = this.notifyListFor(ticket, safeBy);
      return this.appendUnlocked('ticket-review-approved', { ticketId, by: safeBy, notify });
    });
  }

  requestChanges({ id, by, comment } = {}) {
    const ticketId = validateTicketId(id);
    const safeBy = validateAgentId(by, 'by');
    const safeComment = requireString(comment, 'comment', { maxLength: 2000 });
    return this.withLock(() => {
      const ticket = this.snapshot().tickets[ticketId];
      if (!ticket) throw new TicketStateError('ticket does not exist', { id: ticketId });
      // requestChanges is review -> in-progress only.
      if (ticket.state !== 'review') {
        throw new TicketStateError(`cannot request changes from state ${ticket.state}`, { id: ticketId, state: ticket.state });
      }
      const notify = this.notifyListFor(ticket, safeBy);
      return this.appendUnlocked('ticket-changes-requested', {
        ticketId, by: safeBy, comment: safeComment, notify,
      });
    });
  }

  close({ id, by, resolution } = {}) {
    const ticketId = validateTicketId(id);
    const safeBy = validateAgentId(by, 'by');
    const safeResolution = requireString(resolution, 'resolution', { maxLength: 500 });
    return this.withLock(() => {
      const ticket = this.snapshot().tickets[ticketId];
      if (!ticket) throw new TicketStateError('ticket does not exist', { id: ticketId });
      this.assertTransition(ticket, 'archived');
      const notify = this.notifyListFor(ticket, safeBy);
      return this.appendUnlocked('ticket-closed', {
        ticketId, by: safeBy, resolution: safeResolution, notify,
      });
    });
  }

  reopen({ id, by, reason } = {}) {
    const ticketId = validateTicketId(id);
    const safeBy = validateAgentId(by, 'by');
    const safeReason = requireString(reason, 'reason', { maxLength: 500 });
    return this.withLock(() => {
      const ticket = this.snapshot().tickets[ticketId];
      if (!ticket) throw new TicketStateError('ticket does not exist', { id: ticketId });
      if (ticket.state !== 'done' && ticket.state !== 'archived') {
        throw new TicketStateError(`can only reopen done or archived; got ${ticket.state}`, { id: ticketId, state: ticket.state });
      }
      const notify = this.notifyListFor(ticket, safeBy);
      return this.appendUnlocked('ticket-reopened', { ticketId, by: safeBy, reason: safeReason, notify });
    });
  }

  addDependency({ id, dependsOn, by } = {}) {
    const ticketId = validateTicketId(id);
    const depId = validateTicketId(dependsOn, 'dependsOn');
    const safeBy = validateAgentId(by, 'by');
    if (ticketId === depId) {
      throw new TicketValidationError('ticket cannot depend on itself', { id: ticketId });
    }
    return this.withLock(() => {
      const snap = this.snapshot();
      const ticket = snap.tickets[ticketId];
      if (!ticket) throw new TicketStateError('ticket does not exist', { id: ticketId });
      if (!snap.tickets[depId]) throw new TicketStateError('dependency does not exist', { dependsOn: depId });
      if (ticket.dependsOn.includes(depId)) {
        throw new TicketStateError('dependency already exists', { id: ticketId, dependsOn: depId });
      }
      // Cycle check: walk forward from depId and ensure we never reach ticketId.
      if (this.wouldCycle(snap, ticketId, depId)) {
        throw new TicketStateError('dependency would create a cycle', { id: ticketId, dependsOn: depId });
      }
      return this.appendUnlocked('ticket-dependency-added', { ticketId, dependsOn: depId, by: safeBy });
    });
  }

  removeDependency({ id, dependsOn, by } = {}) {
    const ticketId = validateTicketId(id);
    const depId = validateTicketId(dependsOn, 'dependsOn');
    const safeBy = validateAgentId(by, 'by');
    return this.withLock(() => {
      const ticket = this.snapshot().tickets[ticketId];
      if (!ticket) throw new TicketStateError('ticket does not exist', { id: ticketId });
      if (!ticket.dependsOn.includes(depId)) {
        throw new TicketStateError('dependency not present', { id: ticketId, dependsOn: depId });
      }
      return this.appendUnlocked('ticket-dependency-removed', { ticketId, dependsOn: depId, by: safeBy });
    });
  }

  // ------------------------------------------------------------------------
  // Multi-assignee — singular `assignedTo` is the derived primary (first in
  // the assignees list). assign() still rewrites the primary (legacy contract);
  // addAssignee()/removeAssignee() manipulate the full set.
  // ------------------------------------------------------------------------

  addAssignee({ id, assignee, by } = {}) {
    const ticketId = validateTicketId(id);
    const safeAssignee = validateAgentId(assignee, 'assignee');
    const safeBy = validateAgentId(by, 'by');
    return this.withLock(() => {
      const ticket = this.snapshot().tickets[ticketId];
      if (!ticket) throw new TicketStateError('ticket does not exist', { id: ticketId });
      if (TERMINAL_STATES.has(ticket.state)) {
        throw new TicketStateError(`cannot add assignee to ${ticket.state} ticket`, { id: ticketId, state: ticket.state });
      }
      if ((ticket.assignees || []).includes(safeAssignee)) {
        throw new TicketStateError('assignee already attached', { id: ticketId, assignee: safeAssignee });
      }
      return this.appendUnlocked('ticket-assignee-added', { ticketId, assignee: safeAssignee, by: safeBy });
    });
  }

  removeAssignee({ id, assignee, by } = {}) {
    const ticketId = validateTicketId(id);
    const safeAssignee = validateAgentId(assignee, 'assignee');
    const safeBy = validateAgentId(by, 'by');
    return this.withLock(() => {
      const ticket = this.snapshot().tickets[ticketId];
      if (!ticket) throw new TicketStateError('ticket does not exist', { id: ticketId });
      if (!(ticket.assignees || []).includes(safeAssignee)) {
        throw new TicketStateError('assignee not attached', { id: ticketId, assignee: safeAssignee });
      }
      return this.appendUnlocked('ticket-assignee-removed', { ticketId, assignee: safeAssignee, by: safeBy });
    });
  }

  // ------------------------------------------------------------------------
  // Watchers — receive notifications on state changes but do not own.
  // ------------------------------------------------------------------------

  addWatcher({ id, watcher, by } = {}) {
    const ticketId = validateTicketId(id);
    const safeWatcher = validateAgentId(watcher, 'watcher');
    const safeBy = validateAgentId(by, 'by');
    return this.withLock(() => {
      const ticket = this.snapshot().tickets[ticketId];
      if (!ticket) throw new TicketStateError('ticket does not exist', { id: ticketId });
      if ((ticket.watchers || []).includes(safeWatcher)) {
        throw new TicketStateError('already watching', { id: ticketId, watcher: safeWatcher });
      }
      return this.appendUnlocked('ticket-watcher-added', { ticketId, watcher: safeWatcher, by: safeBy });
    });
  }

  removeWatcher({ id, watcher, by } = {}) {
    const ticketId = validateTicketId(id);
    const safeWatcher = validateAgentId(watcher, 'watcher');
    const safeBy = validateAgentId(by, 'by');
    return this.withLock(() => {
      const ticket = this.snapshot().tickets[ticketId];
      if (!ticket) throw new TicketStateError('ticket does not exist', { id: ticketId });
      if (!(ticket.watchers || []).includes(safeWatcher)) {
        throw new TicketStateError('not watching', { id: ticketId, watcher: safeWatcher });
      }
      return this.appendUnlocked('ticket-watcher-removed', { ticketId, watcher: safeWatcher, by: safeBy });
    });
  }

  // ------------------------------------------------------------------------
  // Attachments — relative repo paths + SHA-256 of file contents at attach time.
  // The store does NOT copy or host the file; it records the reference. The
  // hash is computed from the file on disk when this method runs, so callers
  // who pass an `expectedSha256` get an integrity check at attach time.
  // ------------------------------------------------------------------------

  attachFile({ id, filePath, by, repoRoot = process.cwd(), expectedSha256 = null } = {}) {
    const ticketId = validateTicketId(id);
    const safeBy = validateAgentId(by, 'by');
    const relative = validateRelativePath(filePath, 'filePath');
    const safeRepoRoot = path.resolve(repoRoot);
    const absolute = path.resolve(safeRepoRoot, relative);
    // Refuse to follow a path that escapes the repo root.
    if (!absolute.startsWith(safeRepoRoot + path.sep) && absolute !== safeRepoRoot) {
      throw new TicketValidationError('filePath escapes repo root', { filePath: relative });
    }
    let stat;
    try {
      stat = fs.statSync(absolute);
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new TicketValidationError('attachment file does not exist', { filePath: relative });
      }
      throw err;
    }
    if (!stat.isFile()) {
      throw new TicketValidationError('attachment path is not a regular file', { filePath: relative });
    }
    // Streaming hash so we don't load very large files into a Buffer.
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(absolute, 'r');
    const buf = Buffer.alloc(64 * 1024);
    try {
      let read = 0;
      // eslint-disable-next-line no-cond-assign
      while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
        hash.update(buf.subarray(0, read));
      }
    } finally {
      fs.closeSync(fd);
    }
    const sha256 = hash.digest('hex');
    if (expectedSha256 != null) {
      if (!isHexSha256(expectedSha256)) {
        throw new TicketValidationError('expectedSha256 must be hex-encoded SHA-256', { expectedSha256 });
      }
      if (expectedSha256 !== sha256) {
        throw new TicketValidationError('attachment hash mismatch', {
          filePath: relative, expected: expectedSha256, actual: sha256,
        });
      }
    }
    return this.withLock(() => {
      const ticket = this.snapshot().tickets[ticketId];
      if (!ticket) throw new TicketStateError('ticket does not exist', { id: ticketId });
      // Reject attaching the same file path twice with the same hash — that's
      // an idempotency hint, not a real attachment.
      const dup = (ticket.attachments || []).find(
        (a) => a.path === relative && a.sha256 === sha256,
      );
      if (dup) {
        throw new TicketStateError('attachment already recorded with matching hash', {
          id: ticketId, filePath: relative, sha256,
        });
      }
      return this.appendUnlocked('ticket-attachment-added', {
        ticketId, by: safeBy, path: relative, sha256, bytes: stat.size,
      });
    });
  }

  // ------------------------------------------------------------------------
  // SLA pause windows — paused durations are subtracted from elapsed SLA. The
  // window record carries `from`, `to`, and `reason`. `to === null` means the
  // window is open-ended (still paused). Each ticket may have at most one open
  // window at a time.
  // ------------------------------------------------------------------------

  setSlaPause({ id, by, until = null, reason } = {}) {
    const ticketId = validateTicketId(id);
    const safeBy = validateAgentId(by, 'by');
    const safeReason = requireString(reason, 'reason', { maxLength: 500 });
    const safeUntil = until != null ? validateIsoTimestamp(until, 'until') : null;
    return this.withLock(() => {
      const ticket = this.snapshot().tickets[ticketId];
      if (!ticket) throw new TicketStateError('ticket does not exist', { id: ticketId });
      if (TERMINAL_STATES.has(ticket.state)) {
        throw new TicketStateError(`cannot pause SLA on ${ticket.state} ticket`, { id: ticketId, state: ticket.state });
      }
      const existing = (ticket.slaPauseWindows || []).find((w) => w.to == null);
      if (existing) {
        throw new TicketStateError('an SLA pause window is already open', {
          id: ticketId, from: existing.from,
        });
      }
      if (safeUntil != null && Date.parse(safeUntil) <= Date.parse(this.now())) {
        throw new TicketValidationError('until must be in the future', { until: safeUntil });
      }
      return this.appendUnlocked('ticket-sla-paused', {
        ticketId, by: safeBy, reason: safeReason, until: safeUntil,
      });
    });
  }

  clearSlaPause({ id, by } = {}) {
    const ticketId = validateTicketId(id);
    const safeBy = validateAgentId(by, 'by');
    return this.withLock(() => {
      const ticket = this.snapshot().tickets[ticketId];
      if (!ticket) throw new TicketStateError('ticket does not exist', { id: ticketId });
      const existing = (ticket.slaPauseWindows || []).find((w) => w.to == null);
      if (!existing) {
        throw new TicketStateError('no SLA pause window is open', { id: ticketId });
      }
      return this.appendUnlocked('ticket-sla-resumed', { ticketId, by: safeBy });
    });
  }

  // ------------------------------------------------------------------------
  // Goal binding — pair a ticket with a goal id from the orchestrator. The
  // store does NOT validate the goal id beyond format; consumers (orchestrator)
  // are responsible for keeping goal-state in sync via reconcileGoalCompletion.
  // ------------------------------------------------------------------------

  bindGoal({ id, goalId, by } = {}) {
    const ticketId = validateTicketId(id);
    const safeGoalId = validateTicketId(goalId, 'goalId');
    const safeBy = validateAgentId(by, 'by');
    return this.withLock(() => {
      const ticket = this.snapshot().tickets[ticketId];
      if (!ticket) throw new TicketStateError('ticket does not exist', { id: ticketId });
      if (ticket.goalId && ticket.goalId !== safeGoalId) {
        throw new TicketStateError('ticket is already bound to a different goal', {
          id: ticketId, currentGoalId: ticket.goalId,
        });
      }
      if (ticket.goalId === safeGoalId) {
        throw new TicketStateError('ticket is already bound to this goal', {
          id: ticketId, goalId: safeGoalId,
        });
      }
      return this.appendUnlocked('ticket-goal-bound', { ticketId, goalId: safeGoalId, by: safeBy });
    });
  }

  unbindGoal({ id, by } = {}) {
    const ticketId = validateTicketId(id);
    const safeBy = validateAgentId(by, 'by');
    return this.withLock(() => {
      const ticket = this.snapshot().tickets[ticketId];
      if (!ticket) throw new TicketStateError('ticket does not exist', { id: ticketId });
      if (!ticket.goalId) {
        throw new TicketStateError('ticket is not bound to a goal', { id: ticketId });
      }
      return this.appendUnlocked('ticket-goal-unbound', {
        ticketId, by: safeBy, previousGoalId: ticket.goalId,
      });
    });
  }

  /**
   * reconcileGoalCompletion(goalId, goalState, opts) — when an upstream goal
   * lifecycle event fires, fan it out to every bound ticket:
   *
   *   - goalState === 'done':   in-progress -> review (auto request) for each
   *                             bound ticket; tickets already past review are
   *                             left alone but get a reconciliation event.
   *   - goalState === 'failed': set the goalBlockReason for each bound ticket
   *                             so it shows up under `list({ blockedBy: true })`.
   *
   * Returns `{ goalId, goalState, transitioned: [...], blocked: [...], skipped: [...] }`.
   */
  reconcileGoalCompletion({ goalId, goalState, by, reason = null, reviewer = null } = {}) {
    const safeGoalId = validateTicketId(goalId, 'goalId');
    const safeBy = validateAgentId(by, 'by');
    if (goalState !== 'done' && goalState !== 'failed') {
      throw new TicketValidationError('goalState must be one of: done, failed', { goalState });
    }
    const safeReviewer = reviewer ? validateAgentId(reviewer, 'reviewer') : safeBy;
    const safeReason = reason != null ? requireString(reason, 'reason', { maxLength: 500 }) : null;
    return this.withLock(() => {
      const snap = this.snapshot();
      const bound = Object.values(snap.tickets).filter((t) => t.goalId === safeGoalId);
      const transitioned = [];
      const blocked = [];
      const skipped = [];
      for (const ticket of bound) {
        if (goalState === 'done') {
          if (ticket.state === 'in-progress') {
            const notify = this.notifyListFor(ticket, safeBy);
            this.appendUnlocked('ticket-review-requested', {
              ticketId: ticket.id, by: safeBy, reviewer: safeReviewer, notify,
              reason: `goal-completed:${safeGoalId}`,
            });
            this.appendUnlocked('ticket-goal-reconciled', {
              ticketId: ticket.id, by: safeBy, goalId: safeGoalId,
              goalState, action: 'requestReview',
            });
            transitioned.push(ticket.id);
          } else {
            this.appendUnlocked('ticket-goal-reconciled', {
              ticketId: ticket.id, by: safeBy, goalId: safeGoalId,
              goalState, action: 'noop', state: ticket.state,
            });
            skipped.push({ id: ticket.id, state: ticket.state });
          }
        } else if (goalState === 'failed') {
          this.appendUnlocked('ticket-goal-reconciled', {
            ticketId: ticket.id, by: safeBy, goalId: safeGoalId,
            goalState, action: 'block', reason: safeReason || 'goal-failed',
          });
          blocked.push(ticket.id);
        }
      }
      return { goalId: safeGoalId, goalState, transitioned, blocked, skipped };
    });
  }

  // ------------------------------------------------------------------------
  // Bulk transitions — operate on a `list()` filter. Each ticket transitions
  // individually (FSM rules still apply); per-ticket failures are surfaced in
  // the result so the caller can decide whether to retry.
  // ------------------------------------------------------------------------

  bulkTransition({ filter = {}, to, by, comment = null, resolution = null, reviewer = null, reason = null } = {}) {
    const safeBy = validateAgentId(by, 'by');
    if (typeof to !== 'string' || !to) {
      throw new TicketValidationError('to (target state) is required', { to });
    }
    return this.withLock(() => {
      const snap = this.snapshot();
      const items = Object.values(snap.tickets).filter((t) => {
        if (filter.status && t.state !== filter.status) return false;
        if (filter.assignedTo) {
          const inAssignees = Array.isArray(t.assignees) && t.assignees.includes(filter.assignedTo);
          if (t.assignedTo !== filter.assignedTo && !inAssignees) return false;
        }
        if (filter.priority && t.priority !== filter.priority) return false;
        if (filter.goalId && t.goalId !== filter.goalId) return false;
        if (filter.blockedBy === true && !t.blocked) return false;
        if (filter.blockedBy === false && t.blocked) return false;
        return true;
      });
      const ok = [];
      const failed = [];
      for (const ticket of items) {
        try {
          // We're already inside the lock; call the internal-flow helpers via
          // appendUnlocked + FSM check rather than re-entering withLock from
          // each transition method (which would deadlock on the mkdir lockdir).
          this.assertBulkTransition(ticket, to);
          const notify = this.notifyListFor(ticket, safeBy);
          if (to === 'review') {
            const r = reviewer ? validateAgentId(reviewer, 'reviewer') : safeBy;
            this.appendUnlocked('ticket-review-requested', {
              ticketId: ticket.id, by: safeBy, reviewer: r, notify,
            });
          } else if (to === 'done') {
            this.appendUnlocked('ticket-review-approved', {
              ticketId: ticket.id, by: safeBy, notify,
            });
          } else if (to === 'in-progress' && ticket.state === 'review') {
            const c = requireString(comment, 'comment', { maxLength: 2000 });
            this.appendUnlocked('ticket-changes-requested', {
              ticketId: ticket.id, by: safeBy, comment: c, notify,
            });
          } else if (to === 'in-progress' && ticket.state === 'open') {
            this.appendUnlocked('ticket-claimed', {
              ticketId: ticket.id, by: safeBy, notify,
            });
          } else if (to === 'in-progress' && (ticket.state === 'done' || ticket.state === 'archived')) {
            const r = requireString(reason, 'reason', { maxLength: 500 });
            this.appendUnlocked('ticket-reopened', {
              ticketId: ticket.id, by: safeBy, reason: r, notify,
            });
          } else if (to === 'archived') {
            const res = requireString(resolution, 'resolution', { maxLength: 500 });
            this.appendUnlocked('ticket-closed', {
              ticketId: ticket.id, by: safeBy, resolution: res, notify,
            });
          } else {
            throw new TicketStateError(`unsupported bulk target ${to}`, { id: ticket.id });
          }
          ok.push(ticket.id);
          // Update local view so chained bulk ops within the same call see
          // the new state.
          ticket.state = to;
        } catch (err) {
          failed.push({ id: ticket.id, error: err.message, code: err.code || null });
        }
      }
      return { ok, failed, count: ok.length, attempted: items.length };
    });
  }

  // Internal flavour of assertTransition that the bulk path uses; identical
  // semantics to assertTransition but lets us report the failure in a result
  // record rather than throwing out of the whole batch.
  assertBulkTransition(ticket, target) {
    const allowed = TRANSITIONS[ticket.state];
    if (!allowed || !allowed.has(target)) {
      throw new TicketStateError(`invalid transition ${ticket.state} -> ${target}`, {
        id: ticket.id, from: ticket.state, to: target,
      });
    }
  }

  wouldCycle(snap, startId, depId) {
    // BFS forward through dependsOn graph starting at depId; if we hit startId,
    // adding startId -> depId would close a cycle.
    const visited = new Set();
    const queue = [depId];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === startId) return true;
      if (visited.has(cur)) continue;
      visited.add(cur);
      const node = snap.tickets[cur];
      if (!node) continue;
      for (const next of node.dependsOn) queue.push(next);
    }
    return false;
  }

  assertTransition(ticket, target) {
    const allowed = TRANSITIONS[ticket.state];
    if (!allowed || !allowed.has(target)) {
      throw new TicketStateError(`invalid transition ${ticket.state} -> ${target}`, {
        id: ticket.id,
        from: ticket.state,
        to: target,
      });
    }
  }

  // ------------------------------------------------------------------------
  // SLA detection. A ticket "breaches" when:
  //   - it has a positive slaHours value, AND
  //   - it is not yet terminal (state !== 'archived'), AND
  //   - hours since createdAt exceeds slaHours.
  // We do NOT count ticket-reopened as resetting the SLA clock — the SLA is
  // measured against the original createdAt. Operator-facing escalation only
  // cares about how long an open issue has been sitting.
  // ------------------------------------------------------------------------

  checkSlaBreaches({ now = null } = {}) {
    const nowISO = now || this.now();
    const snap = this.snapshot();
    const breaches = [];
    for (const ticket of Object.values(snap.tickets)) {
      if (ticket.slaHours == null) continue;
      if (ticket.state === 'archived') continue;
      const rawElapsed = hoursBetween(ticket.createdAt, nowISO);
      if (rawElapsed == null) continue;
      // Subtract any paused windows from the elapsed clock. An open-ended
      // window (no `to`) is treated as paused up to now. We do this AFTER the
      // raw elapsed calculation rather than baking it into hoursBetween so
      // existing callers of hoursBetween are not affected.
      const paused = pausedHours(ticket.slaPauseWindows || [], ticket.createdAt, nowISO);
      const elapsed = Math.max(0, rawElapsed - paused);
      const breachExpected = elapsed > ticket.slaHours;
      if (breachExpected) {
        breaches.push({
          id: ticket.id,
          title: ticket.title,
          state: ticket.state,
          assignedTo: ticket.assignedTo,
          assignees: Array.isArray(ticket.assignees) ? ticket.assignees.slice() : [],
          watchers: Array.isArray(ticket.watchers) ? ticket.watchers.slice() : [],
          priority: ticket.priority,
          slaHours: ticket.slaHours,
          elapsedHours: Number(elapsed.toFixed(2)),
          rawElapsedHours: Number(rawElapsed.toFixed(2)),
          pausedHours: Number(paused.toFixed(2)),
          paused: paused > 0,
          createdAt: ticket.createdAt,
          updatedAt: ticket.updatedAt,
          goalId: ticket.goalId || null,
        });
      }
    }
    breaches.sort((a, b) => b.elapsedHours - a.elapsedHours);
    return breaches;
  }

  /**
   * slaStatus({ id, now }) — return raw, paused, and effective elapsed hours
   * plus a derived `breached` flag. Used by the CLI `sla-status` action and by
   * the GitHub workflow to render a consistent breach report.
   */
  slaStatus({ id, now = null } = {}) {
    const ticketId = validateTicketId(id);
    const nowISO = now || this.now();
    const ticket = this.snapshot().tickets[ticketId];
    if (!ticket) throw new TicketStateError('ticket does not exist', { id: ticketId });
    if (ticket.slaHours == null) {
      return { id: ticketId, slaHours: null, breached: false, paused: false };
    }
    const raw = hoursBetween(ticket.createdAt, nowISO);
    const paused = pausedHours(ticket.slaPauseWindows || [], ticket.createdAt, nowISO);
    const effective = raw == null ? null : Math.max(0, raw - paused);
    const active = (ticket.slaPauseWindows || []).find((w) => w.to == null) || null;
    return {
      id: ticketId,
      slaHours: ticket.slaHours,
      createdAt: ticket.createdAt,
      now: nowISO,
      rawElapsedHours: raw == null ? null : Number(raw.toFixed(2)),
      pausedHours: Number(paused.toFixed(2)),
      elapsedHours: effective == null ? null : Number(effective.toFixed(2)),
      paused: Boolean(active),
      activePause: active ? { from: active.from, until: active.to || null, reason: active.reason } : null,
      breached: effective != null && effective > ticket.slaHours && ticket.state !== 'archived',
    };
  }

  // Operator-facing recap. Counts by state, recent transitions, breach list.
  recap({ days = 7, now = null } = {}) {
    const nowISO = now || this.now();
    const sinceMs = Date.parse(nowISO) - days * 86400000;
    const snap = this.snapshot();
    const byState = {};
    for (const s of STATES) byState[s] = 0;
    let breaches = 0;
    const recent = [];
    for (const ticket of Object.values(snap.tickets)) {
      byState[ticket.state] = (byState[ticket.state] || 0) + 1;
      const upd = Date.parse(ticket.updatedAt);
      if (Number.isFinite(upd) && upd >= sinceMs) {
        recent.push({ id: ticket.id, title: ticket.title, state: ticket.state, updatedAt: ticket.updatedAt });
      }
    }
    const breachList = this.checkSlaBreaches({ now: nowISO });
    breaches = breachList.length;
    recent.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      schema: 'openclaw-frontier.ticket-recap.v1',
      ticketsPath: path.relative(process.cwd(), this.ticketsPath).replace(/\\/g, '/'),
      windowDays: days,
      now: nowISO,
      counts: byState,
      total: Object.values(snap.tickets).length,
      slaBreachCount: breaches,
      slaBreaches: breachList.slice(0, 20),
      recentlyUpdated: recent.slice(0, 20),
    };
  }
}

function createTicketStore(options) {
  return new TicketStore(options);
}

// v0.8.0: re-export template helpers through this module so callers only need
// one import for the whole ticket toolkit. The templates module itself stays
// independently importable for environments that want to load templates
// without instantiating a store.
const templates = require('./templates');

module.exports = {
  SCHEMA,
  STATES,
  TRANSITIONS,
  PRIORITIES: Array.from(PRIORITIES),
  TicketStore,
  TicketStateError,
  TicketValidationError,
  TicketTemplateError: templates.TicketTemplateError,
  createTicketStore,
  parseJsonl,
  pausedHours,
  loadTemplate: templates.loadTemplate,
  listTemplates: templates.listTemplates,
  applyTemplate: templates.applyTemplate,
};
