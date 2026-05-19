#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  TicketStore,
  TicketStateError,
  TicketValidationError,
  createTicketStore,
  STATES,
  TRANSITIONS,
} = require('../lib/ticket-store');

// Deterministic-ish clock for reproducible tests.
function makeClock(startMs) {
  let cursor = startMs;
  return {
    advance(ms) { cursor += ms; },
    set(ms) { cursor = ms; },
    now() { return new Date(cursor).toISOString(); },
  };
}

function makeStore({ clock, sub = 'a' } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `openclaw-tickets-${sub}-`));
  const ticketsPath = path.join(tmp, 'release-gate', 'tickets.jsonl');
  const store = new TicketStore({
    ticketsPath,
    now: () => clock.now(),
    lockTimeoutMs: 5000,
  });
  return { store, ticketsPath, tmp };
}

let totalChecks = 0;
function check(name, fn) {
  totalChecks += 1;
  try {
    fn();
  } catch (err) {
    process.stderr.write(`FAIL: ${name}\n  ${err.stack || err.message || err}\n`);
    process.exit(1);
  }
}

// ----------------------------------------------------------------------------
// Test 1: open ticket — default state is `open`.
// ----------------------------------------------------------------------------
check('open ticket has default state open', () => {
  const clock = makeClock(Date.parse('2026-05-01T00:00:00Z'));
  const { store } = makeStore({ clock, sub: '1' });
  const evt = store.open({ title: 'first ticket', by: 'orchestrator' });
  assert.ok(evt.ticketId);
  const t = store.get({ id: evt.ticketId });
  assert.strictEqual(t.state, 'open');
  assert.strictEqual(t.title, 'first ticket');
  assert.strictEqual(t.priority, 'p2'); // default
  assert.strictEqual(t.assignedTo, null);
  assert.strictEqual(t.createdBy, 'orchestrator');
});

// ----------------------------------------------------------------------------
// Test 2: claim transitions open -> in-progress, assigns to claimer.
// ----------------------------------------------------------------------------
check('claim moves open -> in-progress', () => {
  const clock = makeClock(Date.parse('2026-05-01T01:00:00Z'));
  const { store } = makeStore({ clock, sub: '2' });
  const opened = store.open({ id: 'tk-claim', title: 'work', by: 'orchestrator' });
  store.claim({ id: opened.ticketId, by: 'builder' });
  const t = store.get({ id: opened.ticketId });
  assert.strictEqual(t.state, 'in-progress');
  assert.strictEqual(t.assignedTo, 'builder');
});

// ----------------------------------------------------------------------------
// Test 3: requestReview -> approveReview path: in-progress -> review -> done.
// ----------------------------------------------------------------------------
check('review request then approval moves to done', () => {
  const clock = makeClock(Date.parse('2026-05-01T02:00:00Z'));
  const { store } = makeStore({ clock, sub: '3' });
  const opened = store.open({ id: 'tk-review', title: 'do stuff', by: 'orchestrator' });
  store.claim({ id: opened.ticketId, by: 'builder' });
  store.requestReview({ id: opened.ticketId, by: 'builder', reviewer: 'reviewer' });
  let t = store.get({ id: opened.ticketId });
  assert.strictEqual(t.state, 'review');
  assert.strictEqual(t.reviewer, 'reviewer');
  store.approveReview({ id: opened.ticketId, by: 'reviewer' });
  t = store.get({ id: opened.ticketId });
  assert.strictEqual(t.state, 'done');
  assert.strictEqual(t.resolution, 'approved');
});

// ----------------------------------------------------------------------------
// Test 4: requestChanges sends review -> in-progress.
// ----------------------------------------------------------------------------
check('requestChanges sends review -> in-progress', () => {
  const clock = makeClock(Date.parse('2026-05-01T03:00:00Z'));
  const { store } = makeStore({ clock, sub: '4' });
  const opened = store.open({ id: 'tk-changes', title: 'changes', by: 'orchestrator' });
  store.claim({ id: opened.ticketId, by: 'builder' });
  store.requestReview({ id: opened.ticketId, by: 'builder', reviewer: 'reviewer' });
  store.requestChanges({ id: opened.ticketId, by: 'reviewer', comment: 'add more tests' });
  const t = store.get({ id: opened.ticketId });
  assert.strictEqual(t.state, 'in-progress');
  assert.strictEqual(t.lastReviewComment, 'add more tests');
});

// ----------------------------------------------------------------------------
// Test 5: invalid transitions throw TicketStateError.
//   - closing an open ticket without resolution -> validation error
//   - claiming a done ticket -> state error
//   - approving from open -> state error
//   - reopen on in-progress -> state error
// ----------------------------------------------------------------------------
check('invalid transitions and validations throw', () => {
  const clock = makeClock(Date.parse('2026-05-01T04:00:00Z'));
  const { store } = makeStore({ clock, sub: '5' });
  const opened = store.open({ id: 'tk-invalid', title: 'bad', by: 'orchestrator' });

  // No resolution string on close -> validation error (missing arg).
  assert.throws(
    () => store.close({ id: opened.ticketId, by: 'orchestrator' }),
    TicketValidationError,
  );

  // Walk to done and then try to claim it again.
  store.claim({ id: opened.ticketId, by: 'builder' });
  store.requestReview({ id: opened.ticketId, by: 'builder', reviewer: 'reviewer' });
  store.approveReview({ id: opened.ticketId, by: 'reviewer' });

  // Cannot claim a done ticket (done -> in-progress is allowed via *reopen*
  // not via claim; claim itself only operates from open).
  assert.throws(
    () => store.claim({ id: opened.ticketId, by: 'builder' }),
    TicketStateError,
  );

  // requestChanges only from review.
  const other = store.open({ id: 'tk-other', title: 'other', by: 'orchestrator' });
  assert.throws(
    () => store.requestChanges({ id: other.ticketId, by: 'reviewer', comment: 'nope' }),
    TicketStateError,
  );

  // reopen only from done/archived.
  store.claim({ id: other.ticketId, by: 'builder' });
  assert.throws(
    () => store.reopen({ id: other.ticketId, by: 'orchestrator', reason: 'no' }),
    TicketStateError,
  );

  // Invalid agent id.
  assert.throws(
    () => store.open({ title: 'bad-by', by: '99 spaces in id!' }),
    TicketValidationError,
  );

  // Cycle prevention.
  const a = store.open({ id: 'tk-cycle-a', title: 'a', by: 'orchestrator' });
  const b = store.open({ id: 'tk-cycle-b', title: 'b', by: 'orchestrator', dependsOn: [a.ticketId] });
  assert.throws(
    () => store.addDependency({ id: a.ticketId, dependsOn: b.ticketId, by: 'orchestrator' }),
    TicketStateError,
  );

  // Self-dependency rejected.
  assert.throws(
    () => store.addDependency({ id: a.ticketId, dependsOn: a.ticketId, by: 'orchestrator' }),
    TicketValidationError,
  );
});

// ----------------------------------------------------------------------------
// Test 6: dependency blocking.
//   B depends on A. B is `blocked` until A closes (done or archived).
//   B's FSM state stays at 'open'/'in-progress' — blocked is a derived flag.
// ----------------------------------------------------------------------------
check('dependency blocking: B blocked until A closes', () => {
  const clock = makeClock(Date.parse('2026-05-01T05:00:00Z'));
  const { store } = makeStore({ clock, sub: '6' });
  const a = store.open({ id: 'tk-dep-a', title: 'upstream', by: 'orchestrator' });
  const b = store.open({ id: 'tk-dep-b', title: 'downstream', by: 'orchestrator', dependsOn: [a.ticketId] });

  let bTicket = store.get({ id: b.ticketId });
  assert.strictEqual(bTicket.blocked, true);
  assert.deepStrictEqual(bTicket.blockedBy, [a.ticketId]);

  // Now close A via the happy path.
  store.claim({ id: a.ticketId, by: 'builder' });
  store.requestReview({ id: a.ticketId, by: 'builder', reviewer: 'reviewer' });
  store.approveReview({ id: a.ticketId, by: 'reviewer' });

  bTicket = store.get({ id: b.ticketId });
  assert.strictEqual(bTicket.blocked, false);
  assert.deepStrictEqual(bTicket.blockedBy, []);

  // list({ blockedBy: true }) should be empty now.
  assert.strictEqual(store.list({ blockedBy: true }).length, 0);

  // Re-create a tickets pair where A is cancelled via close. Closure (any
  // kind) should unblock B — explicit operator intent.
  const c = store.open({ id: 'tk-dep-c', title: 'upstream-cancelled', by: 'orchestrator' });
  const d = store.open({ id: 'tk-dep-d', title: 'downstream', by: 'orchestrator', dependsOn: [c.ticketId] });
  let dTicket = store.get({ id: d.ticketId });
  assert.strictEqual(dTicket.blocked, true);
  store.close({ id: c.ticketId, by: 'orchestrator', resolution: 'wont-fix' });
  dTicket = store.get({ id: d.ticketId });
  assert.strictEqual(dTicket.blocked, false);
});

// ----------------------------------------------------------------------------
// Test 7: SLA breach detection. A ticket older than its slaHours is reported.
// ----------------------------------------------------------------------------
check('SLA breach detection surfaces tickets past their SLA', () => {
  const start = Date.parse('2026-05-01T00:00:00Z');
  const clock = makeClock(start);
  const { store } = makeStore({ clock, sub: '7' });

  store.open({ id: 'tk-sla-1', title: 'fast', by: 'orchestrator', slaHours: 1 });
  store.open({ id: 'tk-sla-2', title: 'slow', by: 'orchestrator', slaHours: 100 });
  // No SLA, should never appear in breaches.
  store.open({ id: 'tk-sla-3', title: 'none', by: 'orchestrator' });

  // 30 minutes later — nothing breached yet.
  clock.advance(30 * 60 * 1000);
  let breaches = store.checkSlaBreaches();
  assert.strictEqual(breaches.length, 0);

  // 2 hours total elapsed -> tk-sla-1 (1h SLA) is breached; tk-sla-2 (100h) not.
  clock.advance(90 * 60 * 1000);
  breaches = store.checkSlaBreaches();
  assert.strictEqual(breaches.length, 1);
  assert.strictEqual(breaches[0].id, 'tk-sla-1');
  assert(breaches[0].elapsedHours > 1);

  // Close tk-sla-1 -> no longer breached (archived is terminal, excluded).
  store.claim({ id: 'tk-sla-1', by: 'builder' });
  store.close({ id: 'tk-sla-1', by: 'orchestrator', resolution: 'done late' });
  breaches = store.checkSlaBreaches();
  assert.strictEqual(breaches.length, 0);
});

// ----------------------------------------------------------------------------
// Test 8: JSONL persistence — state restored from disk on a fresh store.
// ----------------------------------------------------------------------------
check('JSONL persistence: restart store, all state restored', () => {
  const clock = makeClock(Date.parse('2026-05-01T08:00:00Z'));
  const { store, ticketsPath } = makeStore({ clock, sub: '8' });
  store.open({ id: 'tk-p-1', title: 'first', by: 'orchestrator', priority: 'p1' });
  store.open({ id: 'tk-p-2', title: 'second', by: 'orchestrator', dependsOn: ['tk-p-1'] });
  store.claim({ id: 'tk-p-1', by: 'builder' });
  store.requestReview({ id: 'tk-p-1', by: 'builder', reviewer: 'reviewer' });
  // Leave tk-p-1 in 'review'; restart and verify.

  const fresh = createTicketStore({ ticketsPath, now: () => clock.now() });
  const snap = fresh.snapshot();
  assert.strictEqual(Object.keys(snap.tickets).length, 2);
  assert.strictEqual(snap.tickets['tk-p-1'].state, 'review');
  assert.strictEqual(snap.tickets['tk-p-1'].reviewer, 'reviewer');
  assert.strictEqual(snap.tickets['tk-p-1'].priority, 'p1');
  assert.strictEqual(snap.tickets['tk-p-2'].state, 'open');
  assert.deepStrictEqual(snap.tickets['tk-p-2'].dependsOn, ['tk-p-1']);
  assert.strictEqual(snap.tickets['tk-p-2'].blocked, true);

  // Confirm append-only — JSONL file has one record per transition we made.
  // 4 ops: open tk-p-1, open tk-p-2, claim tk-p-1, requestReview tk-p-1.
  const lines = fs.readFileSync(ticketsPath, 'utf8').trim().split(/\r?\n/);
  assert.strictEqual(lines.length, 4, `expected exactly 4 records, got ${lines.length}`);
  for (const line of lines) {
    const parsed = JSON.parse(line);
    assert.strictEqual(parsed.schema, 'openclaw-frontier.ticket-store.v1');
  }
});

// ----------------------------------------------------------------------------
// Test 9: reopen + filtering surface area.
// ----------------------------------------------------------------------------
check('reopen and list filtering', () => {
  const clock = makeClock(Date.parse('2026-05-01T09:00:00Z'));
  const { store } = makeStore({ clock, sub: '9' });
  store.open({ id: 'tk-f-1', title: 'a', by: 'orchestrator', priority: 'p0' });
  store.open({ id: 'tk-f-2', title: 'b', by: 'orchestrator', priority: 'p1', assignedTo: 'builder' });
  store.claim({ id: 'tk-f-2', by: 'builder' });

  assert.strictEqual(store.list({ status: 'open' }).length, 1);
  assert.strictEqual(store.list({ status: 'in-progress' }).length, 1);
  assert.strictEqual(store.list({ assignedTo: 'builder' }).length, 1);
  assert.strictEqual(store.list({ priority: 'p0' }).length, 1);

  // Close tk-f-2 and reopen.
  store.requestReview({ id: 'tk-f-2', by: 'builder', reviewer: 'reviewer' });
  store.approveReview({ id: 'tk-f-2', by: 'reviewer' });
  store.close({ id: 'tk-f-2', by: 'orchestrator', resolution: 'shipped' });
  assert.strictEqual(store.get({ id: 'tk-f-2' }).state, 'archived');
  store.reopen({ id: 'tk-f-2', by: 'orchestrator', reason: 'regression found' });
  const reopened = store.get({ id: 'tk-f-2' });
  assert.strictEqual(reopened.state, 'in-progress');
  assert.strictEqual(reopened.lastReopenReason, 'regression found');
});

// ----------------------------------------------------------------------------
// Test 10: recap rolls up counts and breaches.
// ----------------------------------------------------------------------------
check('recap summary', () => {
  const clock = makeClock(Date.parse('2026-05-01T10:00:00Z'));
  const { store } = makeStore({ clock, sub: '10' });
  store.open({ id: 'tk-r-1', title: 'a', by: 'orchestrator', slaHours: 1 });
  clock.advance(2 * 3600 * 1000);
  const recap = store.recap({ days: 7 });
  assert.strictEqual(recap.total, 1);
  assert.strictEqual(recap.counts.open, 1);
  assert.strictEqual(recap.slaBreachCount, 1);
  assert.strictEqual(recap.slaBreaches[0].id, 'tk-r-1');
});

// ----------------------------------------------------------------------------
// Smoke check: every state in STATES has a transition entry (or is terminal).
// ----------------------------------------------------------------------------
check('FSM completeness — every state has a transition row', () => {
  for (const s of STATES) {
    assert.ok(Object.prototype.hasOwnProperty.call(TRANSITIONS, s), `missing transition row for ${s}`);
  }
});

console.log(JSON.stringify({
  ok: true,
  checks: totalChecks,
  states: STATES,
}, null, 2));
