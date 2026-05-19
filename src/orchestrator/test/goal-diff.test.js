#!/usr/bin/env node
'use strict';

// goal-diff.test.js
//
// Covers `goalState.diffStates(a, b)` and the CLI `openclaw goal <id> --diff
// <other_id>`. Diff fields:
//
//   - addedLanes:    lane names present in b but not in a
//   - removedLanes:  lane names present in a but not in b
//   - changedLanes:  per-name objects { name, from, to } when timing.status
//                    differs between a and b
//   - addedSubGoals: sub-goal ids only present in b
//   - removedSubGoals: sub-goal ids only present in a
//   - costDelta:     b.cost.usd - a.cost.usd (rounded to 6 decimals)
//   - statusChanged: { from, to } when state.status differs, otherwise null
//
// Cases:
//   1. In-memory fixture diff reports lane added/removed/changed correctly.
//   2. Identical fixtures report no differences (all arrays empty).
//   3. Sub-goal differences propagate to addedSubGoals/removedSubGoals.
//   4. Cost delta computation rounds to 6 decimals.
//   5. CLI: write two real state files via runGoalLoop with different lane sets,
//      then `openclaw goal <a> --diff <b>` prints the expected lines.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const OPENCLAW = path.join(REPO_ROOT, 'bin', 'openclaw');
const goalState = require('../lib/goal-state.js');
const { runGoalLoop } = require('../lib/goal-loop.js');

function setupGoalEnv(prefix) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const blackboardPath = path.join(tmp, 'bb.jsonl');
  const goalsDir = path.join(tmp, 'goals');
  fs.mkdirSync(goalsDir, { recursive: true });
  return { tmp, blackboardPath, goalsDir };
}

function makeState(overrides) {
  return {
    schema: 'openclaw-frontier.goal-state.v2',
    goalId: 'diff-fixture',
    title: 't',
    status: 'done',
    cost: { usd: 0 },
    goal: { id: 'diff-fixture', lanes: [] },
    laneTimings: [],
    subGoalResults: [],
    ...overrides,
  };
}

function caseLaneDiff() {
  const a = makeState({
    cost: { usd: 0.01 },
    goal: { id: 'g', lanes: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] },
    laneTimings: [
      { laneName: 'a', status: 'done' },
      { laneName: 'b', status: 'failed' },
      { laneName: 'c', status: 'done' },
    ],
  });
  const b = makeState({
    status: 'failed',
    cost: { usd: 0.05 },
    goal: { id: 'g', lanes: [{ name: 'a' }, { name: 'b' }, { name: 'd' }] },
    laneTimings: [
      { laneName: 'a', status: 'done' },
      { laneName: 'b', status: 'done' },
      { laneName: 'd', status: 'done' },
    ],
  });
  const out = goalState.diffStates(a, b);
  assert.deepStrictEqual(out.addedLanes, ['d'], 'lane d added');
  assert.deepStrictEqual(out.removedLanes, ['c'], 'lane c removed');
  assert.deepStrictEqual(out.changedLanes, [{ name: 'b', from: 'failed', to: 'done' }], 'b changed');
  assert.deepStrictEqual(out.statusChanged, { from: 'done', to: 'failed' }, 'overall status changed');
  assert.strictEqual(out.costDelta, 0.04, 'cost delta correctly rounded');
}

function caseIdenticalStates() {
  const a = makeState({
    goal: { id: 'g', lanes: [{ name: 'a' }, { name: 'b' }] },
    laneTimings: [
      { laneName: 'a', status: 'done' },
      { laneName: 'b', status: 'done' },
    ],
  });
  // b is a structural copy of a.
  const b = JSON.parse(JSON.stringify(a));
  const out = goalState.diffStates(a, b);
  assert.deepStrictEqual(out.addedLanes, [], 'no added lanes');
  assert.deepStrictEqual(out.removedLanes, [], 'no removed lanes');
  assert.deepStrictEqual(out.changedLanes, [], 'no changed lanes');
  assert.strictEqual(out.statusChanged, null, 'statusChanged is null for identical states');
  assert.strictEqual(out.costDelta, 0, 'cost delta is zero');
}

function caseSubGoalDiff() {
  const a = makeState({ subGoalResults: [{ subGoalId: 'sg1' }, { subGoalId: 'sg2' }] });
  const b = makeState({ subGoalResults: [{ subGoalId: 'sg2' }, { subGoalId: 'sg3' }] });
  const out = goalState.diffStates(a, b);
  assert.deepStrictEqual(out.addedSubGoals, ['sg3'], 'sg3 added');
  assert.deepStrictEqual(out.removedSubGoals, ['sg1'], 'sg1 removed');
}

function caseCostRounding() {
  const a = makeState({ cost: { usd: 1.000001 } });
  const b = makeState({ cost: { usd: 1.000005 } });
  const out = goalState.diffStates(a, b);
  // 0.000004 rounds to 6 decimal precision.
  assert.strictEqual(out.costDelta, 0.000004, 'cost delta preserves microcent precision');
}

async function caseCliDiff() {
  const { blackboardPath, goalsDir } = setupGoalEnv('goal-diff-cli-');
  const aId = 'diff-cli-a';
  const bId = 'diff-cli-b';
  await runGoalLoop({
    goal: {
      id: aId,
      title: 'a',
      lanes: [{ name: 'lane-x', role: 'builder', summary: 'x' }],
    },
    blackboardPath, mockAgents: true, goalsDir, pollIntervalMs: 50,
  });
  await runGoalLoop({
    goal: {
      id: bId,
      title: 'b',
      lanes: [
        { name: 'lane-x', role: 'builder', summary: 'x' },
        { name: 'lane-y', role: 'docs', summary: 'y' },
      ],
    },
    blackboardPath, mockAgents: true, goalsDir, pollIntervalMs: 50,
  });
  const out = execFileSync(process.execPath, [
    OPENCLAW, 'goal', aId, '--diff', bId,
    '--blackboard', blackboardPath,
    '--goals-dir', goalsDir,
  ], { encoding: 'utf8' });
  assert.match(out, new RegExp(`diff: ${aId} -> ${bId}`), 'CLI prints diff header');
  assert.match(out, /\+ lanes: lane-y/, 'lane-y reported as added');
  assert.match(out, /cost delta:/, 'cost delta line present');
}

(async () => {
  caseLaneDiff();
  caseIdenticalStates();
  caseSubGoalDiff();
  caseCostRounding();
  await caseCliDiff();
  console.log(JSON.stringify({ ok: true, suite: 'goal-diff', cases: 5 }));
})().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
