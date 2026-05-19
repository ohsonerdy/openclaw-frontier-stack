#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { createLedger } = require('../../../src/blackboard/lib/ledger.js');
const { TaskFlowRuntime } = require('../../../src/taskflow/lib/taskflow.js');
const {
  subagentFanOut,
  createScopedLedger,
  SubagentScopeError,
} = require('../subagent.js');

function freshLedger(label) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `ofs-subagent-${label}-`));
  return {
    tmp,
    ledger: createLedger({ ledgerPath: path.join(tmp, 'blackboard.jsonl') }),
  };
}

async function testHappyPath() {
  const { tmp, ledger } = freshLedger('ok');
  const taskflow = new TaskFlowRuntime();

  const result = await subagentFanOut({
    parent: 'goal-subagent-ok',
    role: 'reviewer',
    tasks: [
      { id: 'review-a', summary: 'review file a' },
      { id: 'review-b', summary: 'review file b' },
      { id: 'review-c', summary: 'review file c' },
    ],
    blackboard: ledger,
    taskflow,
    mode: 'workers',
    timeoutMs: 2000,
    handler: ({ task }) => ({
      ok: true,
      summary: `reviewed ${task.id}: lgtm`,
      artifacts: [],
      facts: [
        { subject: 'intermediate-note', value: { reviewed: task.id } },
      ],
    }),
  });

  assert.strictEqual(result.pattern, 'subagent');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.results.length, 3);
  assert.strictEqual(result.failed.length, 0);
  assert.strictEqual(result.timedOut.length, 0);
  assert.strictEqual(result.childScopes.length, 3);
  assert.strictEqual(result.childScopes[0], 'subagent:goal-subagent-ok:0');
  assert.strictEqual(result.childScopes[2], 'subagent:goal-subagent-ok:2');

  for (const r of result.results) {
    assert.strictEqual(r.ok, true);
    assert.match(r.summary, /^\[subagent:goal-subagent-ok:\d\]/);
    assert.ok(r.taskId.startsWith('goal-subagent-ok.sub.'));
  }

  // Parent's filtered view returns only result records, not the intermediate
  // facts the workers emitted. The facts are still on the ledger (so they
  // can be audited), just not lifted into parent scope.
  const parentResults = result.parentResults();
  assert.strictEqual(parentResults.length, 3, 'parent sees exactly 3 results');

  const fullSnap = ledger.snapshot();
  // Intermediate facts present on the ledger (one per child):
  const childFacts = fullSnap.facts.filter((f) => f.subject.includes('[subagent:goal-subagent-ok:'));
  assert.strictEqual(childFacts.length, 3, 'each child wrote one intermediate fact');
  // But the parent's filtered view does NOT include them — they are facts,
  // not results.
  for (const pr of parentResults) {
    assert.strictEqual(pr.kind, 'result');
  }

  const tfSnap = taskflow.snapshot();
  for (const taskId of result.childTaskIds) {
    assert.ok(tfSnap.tasks[taskId], `taskflow has task ${taskId}`);
    assert.strictEqual(tfSnap.tasks[taskId].state, 'done');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
}

async function testScopeIsolationRejectsOutOfScopeWrites() {
  const { tmp, ledger } = freshLedger('scope');
  const allowed = 'subagent:goal-x:0';
  const wrong = 'subagent:goal-x:1';
  const scoped = createScopedLedger(ledger, allowed, 'reviewer');

  // Writes that match the scope succeed.
  scoped.recordResult({
    taskId: 'goal-x.sub.0.review',
    ok: true,
    summary: 'in-scope ok',
    scope: allowed,
  });
  // Writes whose scope does not match the child's slice are rejected.
  assert.throws(
    () => scoped.recordFact({ subject: 'leak', value: 1, scope: wrong }),
    SubagentScopeError,
  );
  assert.throws(
    () => scoped.recordResult({ taskId: 'goal-x.sub.0.review', ok: true, summary: 'forged', scope: wrong }),
    SubagentScopeError,
  );
  // Missing scope is also rejected.
  assert.throws(
    () => scoped.recordDecision({ decision: 'd', scope: undefined }),
    SubagentScopeError,
  );

  fs.rmSync(tmp, { recursive: true, force: true });
}

async function testParentViewFiltersIntermediateFacts() {
  const { tmp, ledger } = freshLedger('view');

  // Run a small N=2 fan-out where each worker writes one extra fact via the
  // handler's `facts` return field. Verify the parent's `parentResults()`
  // returns only the result records and none of the intermediate facts.
  const result = await subagentFanOut({
    parent: 'g-view',
    role: 'analyst',
    tasks: [
      { id: 'a', summary: 'analyze a' },
      { id: 'b', summary: 'analyze b' },
    ],
    blackboard: ledger,
    mode: 'workers',
    timeoutMs: 2000,
    handler: ({ task, scope }) => ({
      ok: true,
      summary: `analyzed ${task.id}`,
      facts: [
        { subject: 'private-note-1', value: { secret: scope } },
        { subject: 'private-note-2', value: { secret: scope } },
      ],
    }),
  });
  assert.strictEqual(result.ok, true);

  const parentView = result.parentResults();
  assert.strictEqual(parentView.length, 2);
  for (const r of parentView) assert.strictEqual(r.kind, 'result');

  // Confirm the ledger still contains the 4 child facts; they're just not in
  // the parent's filtered view.
  const snap = ledger.snapshot();
  assert.ok(snap.facts.length >= 4, `ledger has at least 4 child facts (got ${snap.facts.length})`);

  fs.rmSync(tmp, { recursive: true, force: true });
}

async function testTimeoutKillsSlowChild() {
  const { tmp, ledger } = freshLedger('to');

  const result = await subagentFanOut({
    parent: 'goal-timeout',
    role: 'reviewer',
    tasks: [
      { id: 'fast', summary: 'returns fast' },
      { id: 'slow', summary: 'never returns' },
    ],
    blackboard: ledger,
    mode: 'workers',
    timeoutMs: 200,
    handler: ({ task }) => new Promise((resolve) => {
      if (task.id === 'fast') {
        resolve({ ok: true, summary: 'fast done' });
      } else {
        // Sleep way past the parent's per-child timeout.
        setTimeout(() => resolve({ ok: true, summary: 'too late' }), 5000);
      }
    }),
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.timedOut.length, 1);
  assert.strictEqual(result.timedOut[0].scope, 'subagent:goal-timeout:1');
  assert.strictEqual(result.results.length, 1);
  assert.strictEqual(result.results[0].ok, true);
  assert.match(result.results[0].summary, /fast done/);

  fs.rmSync(tmp, { recursive: true, force: true });
}

async function testChildFailureReturnsStructuredError() {
  const { tmp, ledger } = freshLedger('err');

  const result = await subagentFanOut({
    parent: 'goal-err',
    role: 'reviewer',
    tasks: [
      { id: 'ok', summary: 'ok' },
      { id: 'boom', summary: 'will throw' },
    ],
    blackboard: ledger,
    mode: 'workers',
    timeoutMs: 1000,
    handler: ({ task }) => {
      if (task.id === 'boom') throw new Error('synthetic child failure');
      return { ok: true, summary: `did ${task.id}` };
    },
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.failed.length, 1);
  assert.strictEqual(result.failed[0].scope, 'subagent:goal-err:1');
  assert.match(result.failed[0].error, /synthetic child failure/);
  // The non-failing child still produced a result on the ledger.
  assert.strictEqual(result.results.length, 1);
  assert.strictEqual(result.results[0].ok, true);

  fs.rmSync(tmp, { recursive: true, force: true });
}

async function testWorkerCannotForgeParentScopeWrite() {
  // A handler attempts to return a value whose `facts[]` carries an entry
  // we'd then try to record. Because the parent always writes facts through
  // the scoped adapter with the child's own scope, even if a worker returned
  // a forged "scope" inside the value, the parent's call site overrides it
  // with the child's true scope. So the *fact* is recorded — just with the
  // child's real scope, not the forged one. Verify the parent ledger view
  // only ever sees subagent-prefixed facts.
  const { tmp, ledger } = freshLedger('forge');
  const result = await subagentFanOut({
    parent: 'g-forge',
    role: 'reviewer',
    tasks: [{ id: 'a', summary: 'a' }],
    blackboard: ledger,
    mode: 'workers',
    timeoutMs: 1000,
    handler: () => ({
      ok: true,
      summary: 'done',
      // Try to lie: claim a different scope. The parent's call site
      // overrides this with the child's true assigned scope.
      facts: [{ subject: 'forged', value: { claimedScope: 'subagent:other:99' } }],
    }),
  });
  assert.strictEqual(result.ok, true);
  const snap = ledger.snapshot();
  // The fact's subject is prefixed with the REAL scope, not the forged one.
  const childFacts = snap.facts.filter((f) => f.subject.includes('[subagent:g-forge:0]'));
  assert.strictEqual(childFacts.length, 1);
  // No facts leaked under a foreign scope.
  const foreignFacts = snap.facts.filter((f) => f.subject.includes('subagent:other:99'));
  assert.strictEqual(foreignFacts.length, 0);
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function main() {
  await testHappyPath();
  await testScopeIsolationRejectsOutOfScopeWrites();
  await testParentViewFiltersIntermediateFacts();
  await testTimeoutKillsSlowChild();
  await testChildFailureReturnsStructuredError();
  await testWorkerCannotForgeParentScopeWrite();
  process.stdout.write(JSON.stringify({ ok: true, name: 'subagent.test' }) + '\n');
}

main().catch((err) => {
  process.stderr.write(`subagent.test failed: ${err.stack || err.message || err}\n`);
  process.exit(1);
});
