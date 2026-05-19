#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { createLedger } = require('../../../src/blackboard/lib/ledger.js');
const { TaskFlowRuntime } = require('../../../src/taskflow/lib/taskflow.js');
const { chain } = require('../chain.js');

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ofs-chain-'));
  const ledger = createLedger({ ledgerPath: path.join(tmp, 'blackboard.jsonl') });
  const taskflow = new TaskFlowRuntime();

  // Happy path: all 4 steps complete in order.
  const result = await chain({
    goalId: 'goal-chain-test',
    steps: [
      { id: 'research', role: 'researcher', summary: 'gather context' },
      { id: 'spec', role: 'architect', summary: 'draft a spec' },
      { id: 'review-spec', role: 'reviewer', summary: 'review the spec' },
      { id: 'build', role: 'builder', summary: 'implement against spec' },
    ],
    ledger,
    taskflow,
    timeoutMs: 5000,
    pollIntervalMs: 50,
    mockResults: [
      { stepId: 'research', ok: true, summary: 'context gathered' },
      { stepId: 'spec', ok: true, summary: 'spec drafted' },
      { stepId: 'review-spec', ok: true, summary: 'spec approved' },
      { stepId: 'build', ok: true, summary: 'implementation landed' },
    ],
  });

  assert.strictEqual(result.pattern, 'chain');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.completedCount, 4);
  assert.strictEqual(result.steps.length, 4);
  for (const step of result.steps) assert.strictEqual(step.status, 'done');

  // Short-circuit path: step 2 fails → steps 3 and 4 are skipped.
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ofs-chain-fail-'));
  const ledger2 = createLedger({ ledgerPath: path.join(tmp2, 'blackboard.jsonl') });
  const result2 = await chain({
    goalId: 'goal-chain-fail',
    steps: [
      { id: 's1', role: 'researcher', summary: 'one' },
      { id: 's2', role: 'architect', summary: 'two' },
      { id: 's3', role: 'reviewer', summary: 'three' },
    ],
    ledger: ledger2,
    timeoutMs: 5000,
    pollIntervalMs: 50,
    mockResults: [
      { stepId: 's1', ok: true, summary: 's1 ok' },
      { stepId: 's2', ok: false, summary: 's2 failed' },
      { stepId: 's3', ok: true, summary: 's3 not reached' },
    ],
  });
  assert.strictEqual(result2.ok, false);
  assert.strictEqual(result2.steps[0].status, 'done');
  assert.strictEqual(result2.steps[1].status, 'failed');
  assert.strictEqual(result2.steps[2].status, 'skipped');

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(tmp2, { recursive: true, force: true });
  process.stdout.write(JSON.stringify({ ok: true, name: 'chain.test' }) + '\n');
}

main().catch((err) => {
  process.stderr.write(`chain.test failed: ${err.stack || err.message || err}\n`);
  process.exit(1);
});
