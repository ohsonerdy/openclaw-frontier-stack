#!/usr/bin/env node
'use strict';

// goal-cancellation.test.js
//
// Covers the cancel-request observation path. An operator (or another agent)
// writes a `decision` record to the blackboard with
// `decision === 'cancel-request'` and `taskId === goalId`; the goal-loop
// observes that record between lanes and shuts down without dispatching
// further work.
//
// Three cases:
//   1. cancel observed before any lane dispatches -> no claims emitted,
//      state.status === 'cancelled', state.cancelRequest captured.
//   2. cancel observed AFTER lanes ran but before sub-goals execute -> the
//      sub-goals are NOT executed, state.subGoalResults stays empty.
//   3. CLI cancel: invoking `bin/openclaw goal --cancel <id>` writes a
//      decision record on the ledger that's identical in shape to what the
//      goal-loop expects, proving the operator-facing path works end-to-end.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const OPENCLAW = path.join(REPO_ROOT, 'bin', 'openclaw');
const { createLedger } = require(path.join(REPO_ROOT, 'src', 'blackboard', 'lib', 'ledger.js'));
const { runGoalLoop } = require('../lib/goal-loop.js');

function setupGoalEnv(prefix) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const blackboardPath = path.join(tmp, 'bb.jsonl');
  const goalsDir = path.join(tmp, 'goals');
  fs.mkdirSync(goalsDir, { recursive: true });
  return { tmp, blackboardPath, goalsDir };
}

function readState(goalsDir, goalId) {
  return JSON.parse(fs.readFileSync(path.join(goalsDir, `${goalId}.json`), 'utf8'));
}

async function caseCancelBeforeDispatch() {
  const { blackboardPath, goalsDir } = setupGoalEnv('goal-cancel-pre-');
  const goalId = 'cancel-pre';
  // Cancel record is on the ledger BEFORE we call runGoalLoop.
  const ledger = createLedger({ ledgerPath: blackboardPath });
  ledger.recordDecision({
    agent: 'orchestrator',
    taskId: goalId,
    decision: 'cancel-request',
    status: 'accepted',
    rationale: 'operator pressed cancel pre-dispatch',
  });

  const trace = await runGoalLoop({
    goal: {
      id: goalId,
      title: 'pre-dispatch cancel',
      lanes: [
        { name: 'lane-a', role: 'builder', summary: 'a' },
        { name: 'lane-b', role: 'docs', summary: 'b' },
      ],
    },
    blackboardPath,
    mockAgents: true,
    goalsDir,
    pollIntervalMs: 50,
  });
  assert.strictEqual(trace.ok, false, 'cancelled goal should not be ok');
  assert.strictEqual(trace.cancelled, true, 'trace.cancelled flag set');
  const state = readState(goalsDir, goalId);
  assert.strictEqual(state.status, 'cancelled', 'state.status === cancelled');
  assert.ok(state.cancelRequest, 'state.cancelRequest captured');
  assert.match(state.cancelRequest.rationale, /pressed cancel/, 'rationale preserved');
  // No task-claims for the lanes should have been emitted to the ledger.
  const records = ledger.readRecords();
  const laneClaims = records.filter((r) => r.kind === 'task-claim' && r.taskId.startsWith(`${goalId}.`));
  assert.strictEqual(laneClaims.length, 0, 'no lane claims emitted after pre-dispatch cancel');
}

async function caseCancelBeforeSubGoals() {
  const { blackboardPath, goalsDir } = setupGoalEnv('goal-cancel-sub-');
  const goalId = 'cancel-sub';
  // We pre-seed a cancel so the parent's runSimpleLanes returns cancelled
  // before sub-goal execution kicks in.
  const ledger = createLedger({ ledgerPath: blackboardPath });
  ledger.recordDecision({
    agent: 'orchestrator',
    taskId: goalId,
    decision: 'cancel-request',
    status: 'accepted',
    rationale: 'cancel before sub-goals',
  });

  const trace = await runGoalLoop({
    goal: {
      id: goalId,
      title: 'cancel before sub',
      lanes: [{ name: 'plan', role: 'orchestrator', summary: 'plan' }],
      subGoals: [
        { id: 'should-not-run', title: 'must not run', lanes: [{ name: 'x', role: 'builder', summary: 'x' }] },
      ],
    },
    blackboardPath,
    mockAgents: true,
    goalsDir,
    pollIntervalMs: 50,
  });
  assert.strictEqual(trace.cancelled, true, 'cancelled before subgoal');
  const state = readState(goalsDir, goalId);
  assert.strictEqual(state.status, 'cancelled', 'state.status=cancelled');
  assert.strictEqual((state.subGoalResults || []).length, 0, 'no sub-goal executed after cancel');
  // The sub-goal state file MUST NOT exist.
  const subPath = path.join(goalsDir, 'sub', goalId, 'should-not-run.json');
  assert.strictEqual(fs.existsSync(subPath), false, 'sub-goal state file should not exist');
}

function caseCliCancel() {
  const { blackboardPath } = setupGoalEnv('goal-cancel-cli-');
  const goalId = 'cli-cancel-goal';
  const out = execFileSync(process.execPath, [
    OPENCLAW, 'goal', '--cancel', goalId,
    '--blackboard', blackboardPath,
    '--json',
  ], { encoding: 'utf8' });
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.ok, true, 'CLI --cancel exits ok');
  assert.strictEqual(parsed.cancelRequest.kind, 'decision', 'wrote a decision record');
  assert.strictEqual(parsed.cancelRequest.decision, 'cancel-request', 'decision string matches');
  assert.strictEqual(parsed.cancelRequest.taskId, goalId, 'taskId is the goal id');
  // The record is on disk on the ledger.
  const ledger = createLedger({ ledgerPath: blackboardPath });
  const records = ledger.readRecords();
  const found = records.find((r) => r.kind === 'decision' && r.decision === 'cancel-request');
  assert.ok(found, 'cancel-request record present on ledger');
}

(async () => {
  await caseCancelBeforeDispatch();
  await caseCancelBeforeSubGoals();
  caseCliCancel();
  console.log(JSON.stringify({ ok: true, suite: 'goal-cancellation', cases: 3 }));
})().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
