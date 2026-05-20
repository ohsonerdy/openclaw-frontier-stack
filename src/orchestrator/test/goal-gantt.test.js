#!/usr/bin/env node
'use strict';

// goal-gantt.test.js
//
// Covers the ASCII gantt renderer (`goalState.renderGantt`) and its CLI entry
// point (`bin/openclaw goal --gantt <id>`).
//
// Cases:
//   1. Fixture in-memory state -> renderGantt(state, {color:false}) produces
//      labels left, bracketed bars time-aligned, status tag on the right, and
//      no ANSI codes when color is disabled.
//   2. Same fixture with color:true -> the output contains ANSI escapes and
//      stripAnsi() reproduces the no-color version exactly.
//   3. CLI: run a real goal-loop, then `openclaw goal --gantt <id> --no-color`
//      prints a well-formed gantt block with one line per lane.
//   4. Lane that never ran (no timing) -> shows a (not-run) marker.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const OPENCLAW = path.join(REPO_ROOT, 'bin', 'openclaw');
const goalState = require('../lib/goal-state.js');
const { runGoalLoop } = require('../lib/goal-loop.js');

const ANSI_RE = /\x1b\[[0-9;]*m/;

function setupGoalEnv(prefix) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const blackboardPath = path.join(tmp, 'bb.jsonl');
  const goalsDir = path.join(tmp, 'goals');
  fs.mkdirSync(goalsDir, { recursive: true });
  return { tmp, blackboardPath, goalsDir };
}

function makeFixture() {
  return {
    schema: 'openclaw-frontier.goal-state.v2',
    goalId: 'gantt-fixture',
    title: 'fixture',
    status: 'done',
    goal: {
      id: 'gantt-fixture',
      lanes: [
        { name: 'plan', role: 'orchestrator' },
        { name: 'build', role: 'builder' },
        { name: 'review', role: 'reviewer' },
      ],
    },
    laneTimings: [
      { laneName: 'plan', role: 'orchestrator', startMs: 0, endMs: 100, status: 'done', attempt: 0 },
      { laneName: 'build', role: 'builder', startMs: 100, endMs: 400, status: 'done', attempt: 0 },
      { laneName: 'review', role: 'reviewer', startMs: 400, endMs: 500, status: 'failed', attempt: 0 },
    ],
  };
}

function caseNoColorFixture() {
  const state = makeFixture();
  const out = goalState.renderGantt(state, { color: false, width: 40 });
  assert.ok(out.includes('goal: gantt-fixture (done)'), 'header line includes goalId and status');
  assert.ok(out.includes('total: 500ms across 3 lanes'), 'total wall-time line present');
  assert.match(out, /^plan\s+\|\s+\[.*\].*0\.\.100ms done/m, 'plan row well-formed');
  assert.match(out, /^build\s+\|\s+\[.*\].*100\.\.400ms done/m, 'build row well-formed');
  assert.match(out, /^review\s+\|\s+\[.*\].*400\.\.500ms failed/m, 'review row well-formed');
  assert.ok(!ANSI_RE.test(out), 'no ANSI escapes when color is false');
}

function caseColorFixture() {
  const state = makeFixture();
  const colored = goalState.renderGantt(state, { color: true, width: 40 });
  const plain = goalState.renderGantt(state, { color: false, width: 40 });
  assert.ok(ANSI_RE.test(colored), 'colored output contains ANSI codes');
  assert.strictEqual(goalState.stripAnsi(colored), plain, 'stripAnsi reproduces no-color output');
}

function caseLaneNeverRan() {
  const state = makeFixture();
  // Add a lane that has no timing entry.
  state.goal.lanes.push({ name: 'release', role: 'release_manager' });
  const out = goalState.renderGantt(state, { color: false, width: 30 });
  assert.match(out, /^release\s+\|.*\(not-run\)/m, 'release lane marked (not-run)');
}

async function caseCliEndToEnd() {
  const { blackboardPath, goalsDir } = setupGoalEnv('gantt-cli-');
  const goalId = 'gantt-cli-1';
  await runGoalLoop({
    goal: {
      id: goalId,
      title: 'gantt cli test',
      lanes: [
        { name: 'a', role: 'builder', summary: 'a' },
        { name: 'b', role: 'docs', summary: 'b' },
      ],
    },
    blackboardPath,
    mockAgents: true,
    goalsDir,
    pollIntervalMs: 50,
  });
  const out = execFileSync(process.execPath, [
    OPENCLAW, 'goal', '--gantt', goalId,
    '--blackboard', blackboardPath,
    '--goals-dir', goalsDir,
    '--no-color',
  ], { encoding: 'utf8' });
  assert.ok(out.includes(`goal: ${goalId}`), 'CLI gantt prints the header');
  assert.ok(/^a\s+\|/m.test(out), 'lane a row present');
  assert.ok(/^b\s+\|/m.test(out), 'lane b row present');
  assert.ok(!ANSI_RE.test(out), 'CLI --no-color strips ANSI');
}

(async () => {
  caseNoColorFixture();
  caseColorFixture();
  caseLaneNeverRan();
  await caseCliEndToEnd();
  console.log(JSON.stringify({ ok: true, suite: 'goal-gantt', cases: 4 }));
})().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
