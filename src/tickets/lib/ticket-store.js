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
        tickets[id] = {
          id,
          title: record.title,
          body: record.body || '',
          state: 'open',
          priority: record.priority,
          assignedTo: record.assignedTo || null,
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

      switch (record.kind) {
        case 'ticket-assigned':
          ticket.assignedTo = record.to;
          break;
        case 'ticket-claimed':
          ticket.state = 'in-progress';
          ticket.assignedTo = record.by;
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
      ticket.blocked = ticket.blockedBy.length > 0 && (ticket.state === 'open' || ticket.state === 'in-progress');
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
      if (filter.assignedTo && t.assignedTo !== filter.assignedTo) return false;
      if (filter.priority && t.priority !== filter.priority) return false;
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

  open({ id, title, body = '', by, assignedTo = null, priority = 'p2', dependsOn = [], slaHours = null } = {}) {
    const ticketId = id ? validateTicketId(id) : genId('ticket');
    const safeTitle = requireString(title, 'title', { maxLength: 200 });
    const safeBody = body ? requireString(body, 'body', { maxLength: 5000 }) : '';
    const safeBy = validateAgentId(by, 'by');
    const safeAssigned = assignedTo ? validateAgentId(assignedTo, 'assignedTo') : null;
    const safePriority = validatePriority(priority);
    if (!Array.isArray(dependsOn)) throw new TicketValidationError('dependsOn must be an array');
    const safeDeps = dependsOn.map((d) => validateTicketId(d, 'dependsOn'));
    const safeSla = validateSlaHours(slaHours);

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
      return this.appendUnlocked('ticket-claimed', { ticketId, by: safeBy });
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
      return this.appendUnlocked('ticket-review-requested', { ticketId, by: safeBy, reviewer: safeReviewer });
    });
  }

  approveReview({ id, by } = {}) {
    const ticketId = validateTicketId(id);
    const safeBy = validateAgentId(by, 'by');
    return this.withLock(() => {
      const ticket = this.snapshot().tickets[ticketId];
      if (!ticket) throw new TicketStateError('ticket does not exist', { id: ticketId });
      this.assertTransition(ticket, 'done');
      return this.appendUnlocked('ticket-review-approved', { ticketId, by: safeBy });
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
      return this.appendUnlocked('ticket-changes-requested', { ticketId, by: safeBy, comment: safeComment });
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
      return this.appendUnlocked('ticket-closed', { ticketId, by: safeBy, resolution: safeResolution });
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
      return this.appendUnlocked('ticket-reopened', { ticketId, by: safeBy, reason: safeReason });
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
      const elapsed = hoursBetween(ticket.createdAt, nowISO);
      if (elapsed == null) continue;
      if (elapsed > ticket.slaHours) {
        breaches.push({
          id: ticket.id,
          title: ticket.title,
          state: ticket.state,
          assignedTo: ticket.assignedTo,
          priority: ticket.priority,
          slaHours: ticket.slaHours,
          elapsedHours: Number(elapsed.toFixed(2)),
          createdAt: ticket.createdAt,
          updatedAt: ticket.updatedAt,
        });
      }
    }
    breaches.sort((a, b) => b.elapsedHours - a.elapsedHours);
    return breaches;
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

module.exports = {
  SCHEMA,
  STATES,
  TRANSITIONS,
  PRIORITIES: Array.from(PRIORITIES),
  TicketStore,
  TicketStateError,
  TicketValidationError,
  createTicketStore,
  parseJsonl,
};
