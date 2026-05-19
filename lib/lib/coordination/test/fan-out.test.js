#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { createLedger } = require('../../../src/blackboard/lib/ledger.js');
const { TaskFlowRuntime } = require('../../../src/taskflow/lib/taskflow.js');
const { fanOut } = require('../fan-out.js');

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ofs-fan-out-'));
  const ledgerPath = path.join(tmp, 'blackboard.jsonl');
  const ledger = createLedger({ ledgerPath });
  const taskflow = new TaskFlowRuntime();

  const result = await fanOut({
    goalId: 'goal-fan-out-test',
    tasks: [
      { id: 'review-a', role: 'reviewer', summary: 'review file a' },
      { id: 'review-b', role: 'reviewer', summary: 'review file b' },
      { id: 'review-c', role: 'reviewer', summary: 'review file c' },
    ],
    ledger,
    taskflow,
    timeoutMs: 5000,
    pollIntervalMs: 50,
    mockResults: [
      { taskId: 'goal-fan-out-test.review-a', ok: true, summary: 'a clean' },
      { taskId: 'goal-fan-out-test.review-b', ok: true, summary: 'b clean' },
      { taskId: 'goal-fan-out-test.review-c', ok: false, summary: 'c has issue' },
    ],
  });

  assert.strictEqual(result.pattern, 'fan-out');
  assert.strictEqual(result.claims.length, 3);
  assert.strictEqual(result.completed.length, 2);
  assert.strictEqual(result.failed.length, 1);
  assert.strictEqual(result.timedOut.length, 0);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.failed[0].taskId, 'goal-fan-out-test.review-c');

  const tfSnap = taskflow.snapshot();
  assert.ok(tfSnap.tasks['goal-fan-out-test.review-a']);
  assert.strictEqual(tfSnap.tasks['goal-fan-out-test.review-a'].state, 'done');
  assert.strictEqual(tfSnap.tasks['goal-fan-out-test.review-c'].state, 'failed');

  // Timeout path: no mockResults written, so the call should time out fast.
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ofs-fan-out-to-'));
  const ledger2 = createLedger({ ledgerPath: path.join(tmp2, 'blackboard.jsonl') });
  const result2 = await fanOut({
    goalId: 'goal-fan-out-timeout',
    tasks: [{ id: 'never-replies', role: 'reviewer', summary: 'no reply' }],
    ledger: ledger2,
    timeoutMs: 250,
    pollIntervalMs: 50,
  });
  assert.strictEqual(result2.timedOut.length, 1);
  assert.strictEqual(result2.ok, false);

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(tmp2, { recursive: true, force: true });
  process.stdout.write(JSON.stringify({ ok: true, name: 'fan-out.test' }) + '\n');
}

main().catch((err) => {
  process.stderr.write(`fan-out.test failed: ${err.stack || err.message || err}\n`);
  process.exit(1);
});
