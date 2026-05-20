#!/usr/bin/env node
'use strict';

// goal-subgoals.test.js
//
// Covers the sub-goal execution path. A parent goal declares `subGoals: [...]`.
// After the parent's own lanes complete, the orchestrator runs each sub-goal
// inline, persisting child state to `<goalsDir>/sub/<parent-id>/<sub-id>.json`
// and recording the outcome on the parent's `subGoalResults` array.
//
// Three cases:
//   1. Single sub-goal: parent succeeds, child file exists, parent has one
//      subGoalResults entry, child file has parentGoalId === parent.id.
//   2. Multiple sub-goals: every child file is written, ordering is preserved
//      in parent.subGoalResults.
//   3. Child failure surfaces on parent: a pre-seeded failed result for the
//      child's lane causes the child to fail; the parent records that the
//      sub-goal status is 'failed' but the parent itself can still be ok=true
//      because sub-goal failures do not abort the parent automatically.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLedger } = require('../../blackboard/lib/ledger.js');
const { runGoalLoop } = require('../lib/goal-loop.js');
const goalState = require('../lib/goal-state.js');

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

async function caseSingleSubGoal() {
  const { blackboardPath, goalsDir } = setupGoalEnv('goal-sub-single-');
  const parentId = 'parent-single';
  const trace = await runGoalLoop({
    goal: {
      id: parentId,
      title: 'parent w/ one sub',
      lanes: [{ name: 'plan', role: 'orchestrator', summary: 'plan it' }],
      subGoals: [
        {
          id: 'sub-child-1',
          title: 'child',
          lanes: [{ name: 'do-it', role: 'builder', summary: 'do child work' }],
        },
      ],
    },
    blackboardPath,
    mockAgents: true,
    goalsDir,
    pollIntervalMs: 50,
  });
  assert.strictEqual(trace.ok, true, 'parent should be ok');
  assert.strictEqual(trace.subGoalResults.length, 1, 'one subGoalResults entry');
  assert.strictEqual(trace.subGoalResults[0].subGoalId, 'sub-child-1', 'sub-goal id captured');
  assert.strictEqual(trace.subGoalResults[0].ok, true, 'sub-goal completed ok');
  // Child file lives under sub/parent-id/.
  const childPath = path.join(goalsDir, 'sub', parentId, 'sub-child-1.json');
  assert.strictEqual(fs.existsSync(childPath), true, 'child state file exists');
  const child = JSON.parse(fs.readFileSync(childPath, 'utf8'));
  assert.strictEqual(child.status, 'done', 'child.status=done');
  assert.strictEqual(child.parentGoalId, parentId, 'child.parentGoalId points back at parent');
  // Parent state on disk also reflects the sub-goal result.
  const parentState = readState(goalsDir, parentId);
  assert.strictEqual(parentState.subGoalResults.length, 1, 'parent persisted subGoalResults');
  assert.strictEqual(parentState.subGoalResults[0].statePath, childPath, 'parent points at child path');
}

async function caseMultipleSubGoals() {
  const { blackboardPath, goalsDir } = setupGoalEnv('goal-sub-multi-');
  const parentId = 'parent-multi';
  const trace = await runGoalLoop({
    goal: {
      id: parentId,
      title: 'parent w/ three subs',
      lanes: [{ name: 'plan', role: 'orchestrator', summary: 'plan' }],
      subGoals: [
        { id: 'sub-one', title: 'one', lanes: [{ name: 'a', role: 'builder', summary: 'a' }] },
        { id: 'sub-two', title: 'two', lanes: [{ name: 'b', role: 'reviewer', summary: 'b' }] },
        { id: 'sub-three', title: 'three', lanes: [{ name: 'c', role: 'docs', summary: 'c' }] },
      ],
    },
    blackboardPath,
    mockAgents: true,
    goalsDir,
    pollIntervalMs: 50,
  });
  assert.strictEqual(trace.subGoalResults.length, 3, 'three subGoalResults entries');
  // Order must match input order.
  assert.deepStrictEqual(
    trace.subGoalResults.map((s) => s.subGoalId),
    ['sub-one', 'sub-two', 'sub-three'],
    'sub-goal order preserved'
  );
  // Every child file present under sub/parent-id/.
  const subDir = path.join(goalsDir, 'sub', parentId);
  const childFiles = fs.readdirSync(subDir).filter((f) => f.endsWith('.json'));
  assert.strictEqual(childFiles.length, 3, 'three child state files on disk');
  // listSubGoalStates surfaces them all.
  const listed = goalState.listSubGoalStates(goalsDir, parentId);
  assert.strictEqual(listed.length, 3, 'listSubGoalStates returns 3');
}

async function caseChildFailureBubblesToParentRecord() {
  const { blackboardPath, goalsDir } = setupGoalEnv('goal-sub-fail-');
  const parentId = 'parent-childfail';
  // Pre-seed a failure for the child's lane.
  const ledger = createLedger({ ledgerPath: blackboardPath });
  ledger.recordResult({ agent: 'builder', taskId: 'sub-bad.bad-lane', ok: false, summary: 'preseed child failure' });

  const trace = await runGoalLoop({
    goal: {
      id: parentId,
      title: 'parent w/ failing child',
      lanes: [{ name: 'plan', role: 'orchestrator', summary: 'plan' }],
      subGoals: [
        { id: 'sub-bad', title: 'bad child', lanes: [{ name: 'bad-lane', role: 'builder', summary: 'bad' }] },
      ],
    },
    blackboardPath,
    mockAgents: true,
    goalsDir,
    pollIntervalMs: 50,
  });
  // Parent's own lanes succeeded.
  const parentLane = trace.lanes.find((l) => l.name === 'plan');
  assert.strictEqual(parentLane.status, 'done', 'parent plan lane still done');
  // Sub-goal result captured as failed.
  assert.strictEqual(trace.subGoalResults.length, 1, 'one subGoalResults entry');
  assert.strictEqual(trace.subGoalResults[0].ok, false, 'sub-goal recorded as failed');
  assert.strictEqual(trace.subGoalResults[0].status, 'failed', 'sub-goal status=failed');
  const childPath = path.join(goalsDir, 'sub', parentId, 'sub-bad.json');
  const child = JSON.parse(fs.readFileSync(childPath, 'utf8'));
  assert.strictEqual(child.status, 'failed', 'child.status=failed');
}

(async () => {
  await caseSingleSubGoal();
  await caseMultipleSubGoals();
  await caseChildFailureBubblesToParentRecord();
  console.log(JSON.stringify({ ok: true, suite: 'goal-subgoals', cases: 3 }));
})().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
