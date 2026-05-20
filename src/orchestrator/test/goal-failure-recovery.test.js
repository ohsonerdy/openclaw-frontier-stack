#!/usr/bin/env node
'use strict';

// goal-failure-recovery.test.js
//
// Exercises the per-lane `failurePolicy: { onFailure, retries, fallbackRole }`
// surface. Every recovery path emits a `lane-recovery` entry on the persisted
// goal-state file. The four modes covered:
//
//   - abort:    one lane fails -> state.status === 'aborted', subsequent lanes
//               that have not yet been picked up are not retried, recovery
//               entry has finalStatus === 'aborted'.
//   - continue: failing lane stays failed but the goal proceeds; the recovery
//               entry has finalStatus === 'failed-but-continued', degraded.
//   - retry:    a pre-seeded failed result is replaced by a successful retry;
//               recovery entry transitions to finalStatus === 'recovered'.
//   - fallback: a pre-seeded failed result triggers a fallback dispatch under
//               the fallbackRole; recovery records both the original failure
//               and the recovered fallback.
//
// The test seeds failed `result` records on the blackboard BEFORE running the
// goal-loop so the loop sees them on its first poll. In mock-agents mode the
// orchestrator otherwise synthesizes GREEN results, so this is the simplest
// way to force a failure without standing up a live agent.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLedger } = require('../../blackboard/lib/ledger.js');
const { runGoalLoop } = require('../lib/goal-loop.js');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function setupGoalEnv(prefix) {
  const tmp = makeTempDir(prefix);
  const blackboardPath = path.join(tmp, 'bb.jsonl');
  const goalsDir = path.join(tmp, 'goals');
  fs.mkdirSync(goalsDir, { recursive: true });
  return { tmp, blackboardPath, goalsDir };
}

function readState(goalsDir, goalId) {
  return JSON.parse(fs.readFileSync(path.join(goalsDir, `${goalId}.json`), 'utf8'));
}

async function caseAbort() {
  const { blackboardPath, goalsDir } = setupGoalEnv('goal-fail-abort-');
  const goalId = 'abort-policy';
  const ledger = createLedger({ ledgerPath: blackboardPath });
  // Pre-seed a failure for the first lane so the mock-agents synth's GREEN
  // record loses the .find() race to the pre-seeded RED one.
  ledger.recordResult({ agent: 'builder', taskId: `${goalId}.lane-a`, ok: false, summary: 'preseed failure' });

  const trace = await runGoalLoop({
    goal: {
      id: goalId,
      title: 'abort policy',
      lanes: [
        { name: 'lane-a', role: 'builder', summary: 'a', failurePolicy: { onFailure: 'abort' } },
        { name: 'lane-b', role: 'docs', summary: 'b' },
      ],
    },
    blackboardPath,
    mockAgents: true,
    goalsDir,
    pollIntervalMs: 50,
  });
  assert.strictEqual(trace.ok, false, 'abort goal should not be ok');
  assert.strictEqual(trace.aborted, true, 'trace.aborted should be true');
  const state = readState(goalsDir, goalId);
  assert.strictEqual(state.status, 'aborted', 'state.status should be aborted');
  const aborters = state.laneRecovery.filter((r) => r.action === 'abort');
  assert.ok(aborters.length >= 1, 'at least one recovery row with action=abort');
  assert.ok(aborters.some((r) => r.finalStatus === 'aborted'), 'finalStatus=aborted present');
}

async function caseContinue() {
  const { blackboardPath, goalsDir } = setupGoalEnv('goal-fail-continue-');
  const goalId = 'continue-policy';
  const ledger = createLedger({ ledgerPath: blackboardPath });
  ledger.recordResult({ agent: 'builder', taskId: `${goalId}.lane-a`, ok: false, summary: 'preseed failure' });

  const trace = await runGoalLoop({
    goal: {
      id: goalId,
      title: 'continue policy',
      lanes: [
        { name: 'lane-a', role: 'builder', summary: 'a', failurePolicy: { onFailure: 'continue' } },
        { name: 'lane-b', role: 'docs', summary: 'b' },
      ],
    },
    blackboardPath,
    mockAgents: true,
    goalsDir,
    pollIntervalMs: 50,
  });
  assert.strictEqual(trace.ok, false, 'continue with one failed lane is not ok');
  assert.strictEqual(trace.aborted, false, 'trace.aborted should be false for continue');
  const state = readState(goalsDir, goalId);
  assert.strictEqual(state.status, 'failed', 'state.status=failed (not aborted)');
  const cont = state.laneRecovery.find((r) => r.action === 'continue');
  assert.ok(cont, 'a continue recovery entry should be present');
  assert.strictEqual(cont.finalStatus, 'failed-but-continued', 'finalStatus=failed-but-continued');
  assert.strictEqual(cont.degraded, true, 'continue marks the lane degraded');
  // Subsequent lane still completed.
  const laneB = trace.lanes.find((l) => l.name === 'lane-b');
  assert.strictEqual(laneB && laneB.status, 'done', 'lane-b still finished');
}

async function caseRetry() {
  const { blackboardPath, goalsDir } = setupGoalEnv('goal-fail-retry-');
  const goalId = 'retry-policy';
  const ledger = createLedger({ ledgerPath: blackboardPath });
  ledger.recordResult({ agent: 'builder', taskId: `${goalId}.lane-a`, ok: false, summary: 'preseed failure' });

  const trace = await runGoalLoop({
    goal: {
      id: goalId,
      title: 'retry policy',
      lanes: [
        { name: 'lane-a', role: 'builder', summary: 'a', failurePolicy: { onFailure: 'retry', retries: 2 } },
        { name: 'lane-b', role: 'docs', summary: 'b' },
      ],
    },
    blackboardPath,
    mockAgents: true,
    goalsDir,
    pollIntervalMs: 50,
  });
  assert.strictEqual(trace.ok, true, 'retry recovers; trace.ok should be true');
  const state = readState(goalsDir, goalId);
  assert.strictEqual(state.status, 'done', 'state.status=done after retry');
  const retries = state.laneRecovery.filter((r) => r.action === 'retry');
  assert.ok(retries.length >= 1, 'at least one retry recovery entry');
  assert.ok(retries.some((r) => r.finalStatus === 'recovered'), 'one retry finalStatus=recovered');
}

async function caseFallback() {
  const { blackboardPath, goalsDir } = setupGoalEnv('goal-fail-fallback-');
  const goalId = 'fallback-policy';
  const ledger = createLedger({ ledgerPath: blackboardPath });
  ledger.recordResult({ agent: 'builder', taskId: `${goalId}.lane-a`, ok: false, summary: 'preseed failure' });

  const trace = await runGoalLoop({
    goal: {
      id: goalId,
      title: 'fallback policy',
      lanes: [
        {
          name: 'lane-a', role: 'builder', summary: 'a',
          failurePolicy: { onFailure: 'fallback', fallbackRole: 'reviewer' },
        },
        { name: 'lane-b', role: 'docs', summary: 'b' },
      ],
    },
    blackboardPath,
    mockAgents: true,
    goalsDir,
    pollIntervalMs: 50,
  });
  assert.strictEqual(trace.ok, true, 'fallback recovers; trace.ok should be true');
  const state = readState(goalsDir, goalId);
  assert.strictEqual(state.status, 'done', 'state.status=done after fallback');
  const fb = state.laneRecovery.filter((r) => r.action === 'fallback');
  assert.ok(fb.length >= 1, 'fallback recovery present');
  assert.ok(fb.some((r) => r.fallbackRole === 'reviewer'), 'fallbackRole recorded');
  assert.ok(fb.some((r) => r.finalStatus === 'recovered'), 'final fallback row marked recovered');
}

(async () => {
  await caseAbort();
  await caseContinue();
  await caseRetry();
  await caseFallback();
  console.log(JSON.stringify({ ok: true, suite: 'goal-failure-recovery', cases: 4 }));
})().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
