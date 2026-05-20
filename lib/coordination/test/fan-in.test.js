#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { createLedger } = require('../../../src/blackboard/lib/ledger.js');
const { TaskFlowRuntime } = require('../../../src/taskflow/lib/taskflow.js');
const { fanIn } = require('../fan-in.js');

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ofs-fan-in-'));
  const ledger = createLedger({ ledgerPath: path.join(tmp, 'blackboard.jsonl') });
  const taskflow = new TaskFlowRuntime();

  // Pre-seed the upstream results that the joiner will collect over.
  for (const id of ['goal-fan-in-test.up-1', 'goal-fan-in-test.up-2', 'goal-fan-in-test.up-3']) {
    ledger.claimTask({ agent: 'orchestrator', taskId: id, summary: `upstream ${id}` });
    ledger.recordResult({ agent: 'reviewer', taskId: id, ok: true, summary: `upstream ${id} ok`, artifacts: [] });
  }

  const result = await fanIn({
    goalId: 'goal-fan-in-test',
    sourceTaskIds: ['goal-fan-in-test.up-1', 'goal-fan-in-test.up-2', 'goal-fan-in-test.up-3'],
    joiner: { id: 'synthesize', role: 'architect', summary: 'merge the 3 upstream verdicts' },
    ledger,
    taskflow,
    timeoutMs: 5000,
    pollIntervalMs: 50,
    mockJoinerResult: { ok: true, summary: 'all 3 upstream verdicts merged' },
  });

  assert.strictEqual(result.pattern, 'fan-in');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.upstream.complete.length, 3);
  assert.strictEqual(result.upstream.missing.length, 0);
  assert.strictEqual(result.joiner.dispatched, true);
  assert.strictEqual(result.joiner.role, 'architect');
  assert.strictEqual(result.joiner.taskId, 'goal-fan-in-test.synthesize');
  assert.strictEqual(result.joiner.result.ok, true);

  // Missing-upstream path: only seed 1 of 2 expected upstream tasks.
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ofs-fan-in-miss-'));
  const ledger2 = createLedger({ ledgerPath: path.join(tmp2, 'blackboard.jsonl') });
  ledger2.claimTask({ agent: 'orchestrator', taskId: 'g.up-1', summary: 'u1' });
  ledger2.recordResult({ agent: 'reviewer', taskId: 'g.up-1', ok: true, summary: 'ok' });
  const result2 = await fanIn({
    goalId: 'g',
    sourceTaskIds: ['g.up-1', 'g.up-missing'],
    joiner: { id: 'synth', role: 'architect', summary: 'merge' },
    ledger: ledger2,
    timeoutMs: 250,
    pollIntervalMs: 50,
  });
  assert.strictEqual(result2.ok, false);
  assert.strictEqual(result2.upstream.missing.length, 1);
  assert.strictEqual(result2.joiner.dispatched, false);

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(tmp2, { recursive: true, force: true });
  process.stdout.write(JSON.stringify({ ok: true, name: 'fan-in.test' }) + '\n');
}

main().catch((err) => {
  process.stderr.write(`fan-in.test failed: ${err.stack || err.message || err}\n`);
  process.exit(1);
});
